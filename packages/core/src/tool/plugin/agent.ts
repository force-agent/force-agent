export * as AgentTool from "./agent.js"

import { ToolFailure } from "@opencode-ai/ai"
import type { Context } from "@opencode-ai/plugin/effect/plugin"
import { Model } from "@opencode-ai/schema/model"
import type { Info as ToolInfo } from "@opencode-ai/schema/tool"
import { env } from "@opencode-ai/util/env"
import { Effect, Exit, Schema, Scope, Semaphore } from "effect"
import { Agent } from "../../agent.js"
import { PluginRuntime } from "../../plugin/runtime.js"
import { SessionSchema } from "../../session/schema.js"
import { execute as executeTool } from "../runtime.js"
import { SubagentTool } from "./subagent.js"

/**
 * Code Mode face of the subagent capability: `tools.agent.spawn/wait/list/stop`.
 *
 * The `subagent` tool is registered with `codemode: false`, so it is reachable only as a direct
 * tool call. These registrations are the mirror image — Code Mode only — so a program can fan out
 * with `Promise.all` and keep every child's answer inside the sandbox instead of paying for a round
 * trip through the parent's context. Spawning, permission, depth limiting, job bookkeeping and the
 * background notification are delegated to the registered `subagent` tool rather than reimplemented.
 */
export const namespace = "agent"

const NO_TEXT = "Subagent completed without a text response."
const DEFAULT_CONCURRENCY = 8
const DEFAULT_SPAWN_LIMIT = 1000
// Bounds the per-execution spawn ledger. Code Mode call ids are never reused, so entries are only
// evicted to keep the map from growing without bound across a long-lived server process.
const LEDGER_CAPACITY = 512

// force-agent overlay: the budget is read through the shared env helper, so an operator who
// follows the documented `LABHARNESS_*` convention is honored, while the previous `LABFY_*` and `POWER_*` brands and
// the upstream `OPENCODE_*` spelling keep working as fallbacks. Reading `process.env` directly
// silently ignored every branded prefix.
const positiveEnv = (name: string, fallback: number) => {
  const raw = env(name)
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const Status = Schema.Literals(["completed", "running", "error", "cancelled"])

const SpawnInput = Schema.Struct({
  task: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  agent: Schema.optionalKey(Schema.String).annotate({
    description: "Subagent type to run. Defaults to the first available subagent.",
  }),
  description: Schema.optionalKey(Schema.String).annotate({
    description: "A short 3-5 word label for the task, displayed to the user",
  }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      'Override the inherited model as "providerID/modelID" with an optional "#variant". Omit to inherit the parent session model.',
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Return a handle immediately instead of the child's answer. Pass the returned sessionID to agent.wait to collect it.",
  }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description: "Continue an existing child session instead of starting a new one.",
  }),
})

const SpawnOutput = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
})

const WaitInput = Schema.Struct({
  sessionID: SessionSchema.ID.annotate({
    description: "Durable child session id returned by agent.spawn or agent.list.",
  }),
  timeout: Schema.optionalKey(Schema.Number).annotate({
    description: 'Milliseconds to wait before returning status "running". Omit to wait until the child settles.',
  }),
})

const WaitOutput = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Status,
  output: Schema.String,
})

const ListInput = Schema.Struct({})

const ListOutput = Schema.Struct({
  children: Schema.Array(
    Schema.Struct({
      sessionID: SessionSchema.ID,
      status: Status,
      title: Schema.optionalKey(Schema.String),
      agent: Schema.optionalKey(Schema.String),
    }),
  ),
})

const StopInput = Schema.Struct({ sessionID: SessionSchema.ID })
const StopOutput = Schema.Struct({ sessionID: SessionSchema.ID, stopped: Schema.Boolean })

export const Plugin = {
  id: "opencode.tool.agent",
  effect: Effect.fn("AgentTool.Plugin")(function* (ctx: Context) {
    const runtime = yield* PluginRuntime.Service
    const agents = yield* Agent.Service
    // Outlives any single tool execution: background permits are released by a watcher fiber
    // forked here, long after the `spawn` call that took them has returned.
    const scope = yield* Scope.Scope
    const concurrency = positiveEnv("AGENT_CONCURRENCY", DEFAULT_CONCURRENCY)
    const spawnLimit = positiveEnv("AGENT_SPAWN_LIMIT", DEFAULT_SPAWN_LIMIT)
    // One permit set for the whole process: a Code Mode program that fans out with Promise.all
    // admits at most `concurrency` children at a time and queues the rest.
    const permits = Semaphore.makeUnsafe(concurrency)
    const ledger = new Map<string, number>()

    const charge = (callID: string) =>
      Effect.suspend(() => {
        const used = ledger.get(callID) ?? 0
        if (used >= spawnLimit)
          return Effect.fail(
            new ToolFailure({
              message: `Subagent spawn limit reached for this execution (${spawnLimit}). Set LABHARNESS_AGENT_SPAWN_LIMIT to raise it, or collect results before spawning more.`,
            }),
          )
        if (used === 0 && ledger.size >= LEDGER_CAPACITY) {
          const oldest = ledger.keys().next()
          if (!oldest.done) ledger.delete(oldest.value)
        }
        ledger.set(callID, used + 1)
        return Effect.void
      })

    const child = Effect.fn("AgentTool.child")(function* (sessionID: SessionSchema.ID, parentID: SessionSchema.ID) {
      const session = yield* runtime.session
        .get(sessionID)
        .pipe(Effect.mapError((error) => new ToolFailure({ message: `Session not found: ${sessionID}`, error })))
      if (session.parentID !== parentID)
        return yield* new ToolFailure({ message: `Session ${sessionID} is not a child of the current session` })
      return session
    })

    // Same shape as the subagent tool's own reader: the newest completed assistant text, with a
    // generic string standing in for "finished but said nothing".
    const latestAssistantText = Effect.fn("AgentTool.latestAssistantText")(function* (sessionID: SessionSchema.ID) {
      const messages = yield* runtime.session
        .messages({ sessionID, order: "desc", limit: 20 })
        .pipe(Effect.mapError((error) => new ToolFailure({ message: `Failed to read subagent output`, error })))
      const assistant = messages.find(
        (message) =>
          message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
      )
      if (assistant === undefined || assistant.type !== "assistant") return NO_TEXT
      const text = assistant.content
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("")
      return text.length > 0 ? text : NO_TEXT
    })

    const defaultAgent = Effect.fn("AgentTool.defaultAgent")(function* (requested: string | undefined) {
      if (requested !== undefined) return requested
      const available = (yield* agents.list())
        .filter((agent) => agent.mode !== "primary" && !agent.hidden)
        .toSorted((left, right) => left.id.localeCompare(right.id))
      const preferred = available.find((agent) => agent.id === "general") ?? available[0]
      if (preferred === undefined)
        return yield* new ToolFailure({ message: "No subagent is available in this session" })
      return preferred.id as string
    })

    yield* ctx.tool
      .transform((draft) => {
        const subagent = draft.get(SubagentTool.name)

        const delegate = (input: unknown, context: Parameters<ToolInfo["execute"]>[1]) =>
          Effect.suspend(() => {
            if (subagent === undefined)
              return Effect.fail(new ToolFailure({ message: "The subagent tool is not registered" }))
            return executeTool(subagent, input, context).pipe(
              Effect.map((result) => result.output as typeof SpawnOutput.Type),
            )
          })

        draft.add({
          name: "spawn",
          options: { namespace, permission: SubagentTool.name, pinned: true },
          description: [
            "Runs a subagent in a child session and returns its final answer.",
            "Blocking by default: await the call and use the returned `output` directly; independent spawns can run concurrently with Promise.all.",
            "Pass background: true to get a handle back immediately and collect the answer later with agent.wait.",
            "The child inherits the parent session's model unless `model` overrides it.",
          ].join("\n"),
          input: SpawnInput,
          output: SpawnOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* charge(context.id)
              const agent = yield* defaultAgent(input.agent)
              const description = input.description ?? input.task.split("\n", 1)[0]?.slice(0, 60) ?? "subagent task"

              // Model overrides need the child session to exist before the delegate runs, because
              // the subagent tool derives the model from the agent config or the parent session.
              // Creating it here with the matching agent id keeps the delegate on its continuation
              // path, which leaves the session's model untouched.
              let target = input.sessionID
              if (target === undefined && input.model !== undefined) {
                const resolved = yield* agents.resolve(agent)
                if (resolved === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${agent}` })
                const model = yield* Effect.try({
                  try: () => Model.Ref.parse(input.model!),
                  catch: () => new ToolFailure({ message: `Invalid model reference: ${input.model}` }),
                })
                const created = yield* runtime.session
                  .create({ parentID: context.sessionID, title: description, agent: resolved.id, model })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Failed to create subagent session`, error }),
                    ),
                  )
                target = created.id
              }

              const delegated = {
                agent,
                description,
                prompt:
                  target === input.sessionID
                    ? input.task
                    : ["You are a subagent spawned by another session.", input.task].join("\n"),
                ...(target === undefined ? {} : { sessionID: target }),
                ...(input.background === true ? { background: true } : {}),
              }
              // The permit governs the child's *execution*, not the parent's call. `delegate`
              // starts the child before it returns a handle, so a background spawn takes its
              // permit up front and hands it to a watcher fiber that returns it once the child's
              // job settles. Releasing at the end of `spawn` (or skipping the semaphore, as this
              // branch used to) would let an unbounded number of background children run at once.
              if (input.background === true)
                return yield* Effect.acquireUseRelease(
                  permits.take(1),
                  () => delegate(delegated, context),
                  (_, exit) =>
                    Exit.isSuccess(exit)
                      ? runtime.job
                          .wait({ id: exit.value.sessionID })
                          .pipe(
                            Effect.ensuring(permits.release(1)),
                            Effect.forkIn(scope, { startImmediately: true }),
                            Effect.asVoid,
                          )
                      : permits.release(1).pipe(Effect.asVoid),
                )
              return yield* permits.withPermit(delegate(delegated, context))
            }).pipe(
              Effect.map((output) => ({
                output,
                content: output.output,
                metadata: { sessionID: output.sessionID, status: output.status },
              })),
            ),
        })

        draft.add({
          name: "wait",
          options: { namespace, permission: SubagentTool.name, pinned: true },
          description: [
            "Waits for a child session started by agent.spawn and returns its answer.",
            "Idempotent: calling it again after the child settled returns the same answer.",
            'Pass a timeout in milliseconds to poll without blocking; status "running" means it has not settled yet.',
          ].join("\n"),
          input: WaitInput,
          output: WaitOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* child(input.sessionID, context.sessionID)
              const job = yield* runtime.job.wait({
                id: input.sessionID,
                ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
              })
              if (job.timedOut)
                return {
                  sessionID: input.sessionID,
                  status: "running" as const,
                  output: `The subagent is still working (sessionID: ${input.sessionID}).`,
                }
              // A settled job is dropped from the registry once its scope closes, so a later wait
              // falls back to the session itself and replays the durable answer.
              if (job.info === undefined) {
                yield* runtime.session
                  .wait(input.sessionID)
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Session not found: ${input.sessionID}`, error }),
                    ),
                  )
                return {
                  sessionID: input.sessionID,
                  status: "completed" as const,
                  output: yield* latestAssistantText(input.sessionID),
                }
              }
              const status = job.info.status
              const output =
                status === "completed"
                  ? (job.info.output ?? (yield* latestAssistantText(input.sessionID)))
                  : status === "error"
                    ? (job.info.error ?? "Subagent failed")
                    : status === "cancelled"
                      ? "Subagent cancelled"
                      : `The subagent is still working (sessionID: ${input.sessionID}).`
              return { sessionID: input.sessionID, status, output }
            }).pipe(
              Effect.map((output) => ({
                output,
                content: output.output,
                metadata: { sessionID: output.sessionID, status: output.status },
              })),
            ),
        })

        draft.add({
          name: "list",
          options: { namespace, permission: SubagentTool.name, pinned: true },
          description: "Lists the child sessions spawned from the current session and whether each is still running.",
          input: ListInput,
          output: ListOutput,
          execute: (_input, context) =>
            Effect.gen(function* () {
              const sessions = yield* runtime.session.list({ parentID: context.sessionID })
              const children = yield* Effect.forEach(sessions.data, (session) =>
                Effect.gen(function* () {
                  const job = yield* runtime.job.wait({ id: session.id, timeout: 0 })
                  const status =
                    job.info?.status ??
                    (session.time.idle === undefined ? ("running" as const) : ("completed" as const))
                  return {
                    sessionID: session.id,
                    status,
                    ...(session.title === undefined ? {} : { title: session.title }),
                    ...(session.agent === undefined ? {} : { agent: session.agent as string }),
                  }
                }),
              )
              return { children }
            }).pipe(
              Effect.map((output) => ({
                output,
                content: JSON.stringify(output),
                metadata: { count: output.children.length },
              })),
            ),
        })

        draft.add({
          name: "stop",
          options: { namespace, permission: SubagentTool.name, pinned: true },
          description:
            "Interrupts a running child session started by agent.spawn. Returns stopped: false when it had already settled.",
          input: StopInput,
          output: StopOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* child(input.sessionID, context.sessionID)
              const interrupted = yield* runtime.session.interrupt(input.sessionID)
              yield* runtime.job.cancel(input.sessionID)
              return { sessionID: input.sessionID, stopped: interrupted }
            }).pipe(
              Effect.map((output) => ({
                output,
                content: output.stopped
                  ? `Interrupted subagent ${output.sessionID}.`
                  : `Subagent ${output.sessionID} was not running.`,
                metadata: { sessionID: output.sessionID, stopped: output.stopped },
              })),
            ),
        })
      })
      .pipe(Effect.orDie)
  }),
}
