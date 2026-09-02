import { type AstNode, InterpreterRuntimeError } from "../interpreter/model.js"
import { CodeModeDate } from "../values.js"
import { coerceToNumber, coerceToString } from "./value.js"

const dateSetterArguments = new Map<string, number>([
  ["setTime", 1],
  ["setMilliseconds", 1],
  ["setUTCMilliseconds", 1],
  ["setSeconds", 2],
  ["setUTCSeconds", 2],
  ["setMinutes", 3],
  ["setUTCMinutes", 3],
  ["setHours", 4],
  ["setUTCHours", 4],
  ["setDate", 1],
  ["setUTCDate", 1],
  ["setMonth", 2],
  ["setUTCMonth", 2],
  ["setFullYear", 3],
  ["setUTCFullYear", 3],
])

export const dateMethods = new Set([
  "getTime",
  "valueOf",
  "toISOString",
  "toJSON",
  "toString",
  "toUTCString",
  "toGMTString",
  "getFullYear",
  "getMonth",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getSeconds",
  "getMilliseconds",
  "getUTCFullYear",
  "getUTCMonth",
  "getUTCDate",
  "getUTCDay",
  "getUTCHours",
  "getUTCMinutes",
  "getUTCSeconds",
  "getUTCMilliseconds",
  "getTimezoneOffset",
  ...dateSetterArguments.keys(),
])

export const dateStatics = new Set(["now", "parse", "UTC"])

/**
 * power-agent overlay: deterministic clock.
 *
 * A reading of the host clock is what makes a replayed program diverge from the run the user
 * approved, so under the flag *every* path to it has to refuse — not just `Date.now()`. Blocking
 * one spelling is worse than blocking none: `+new Date()` is `Date.now()` by another name, and an
 * error that names only `Date.now()` teaches the model to reach for the spelling that still works.
 *
 * The three paths, all funnelled through `hostNow` below:
 *   - `Date.now()`            — this module, `invokeDateStatic`
 *   - `new Date()`            — `interpreter/runtime.ts`, `constructDate` with no arguments
 *   - `Date()` (no `new`)     — `interpreter/runtime.ts`, the `GlobalNamespace` call path
 *
 * Refusal is a plain `InterpreterRuntimeError` in the phrasing the stdlib already uses for a
 * member it will not serve (`stdlib/math.ts` says `Math.<name> is not available.`), so the program
 * sees a normal runtime error instead of a silently different answer.
 *
 * Off by default; `POWER_CODEMODE_DETERMINISTIC=1` (or the `OPENCODE_` spelling) turns it on at
 * load, and `setDeterministic` flips it in-process. `Date.parse`, `Date.UTC` and
 * `new Date(<explicit timestamp or string>)` stay available: all are pure functions of their
 * arguments.
 */
let deterministic = readDeterministicEnv()

function readDeterministicEnv(): boolean {
  // The interpreter also runs under workerd, where `process` may be absent.
  if (typeof process === "undefined") return false
  const raw = process.env?.["POWER_CODEMODE_DETERMINISTIC"] ?? process.env?.["OPENCODE_CODEMODE_DETERMINISTIC"]
  return raw === "1" || raw?.toLowerCase() === "true"
}

export const isDeterministic = (): boolean => deterministic

export const setDeterministic = (value: boolean): void => {
  deterministic = value
}

/**
 * Guards a reading of the host clock. Exported so any other real-time entry point can refuse the
 * same way with the same message.
 *
 * The message names every blocked spelling on purpose: the earlier wording ("pass an explicit
 * timestamp" alone, after naming only `Date.now()`) read as an invitation to rewrite the call as
 * `+new Date()`, which at the time still returned the host clock.
 */
export const assertRealTimeAllowed = (expression: string, node: AstNode): void => {
  if (!deterministic) return
  throw new InterpreterRuntimeError(
    `${expression} is not available in deterministic mode; every reading of the host clock ` +
      `(Date.now(), Date(), new Date() with no argument) is refused. Pass an explicit timestamp, ` +
      `e.g. new Date(1700000000000), or use Date.parse()/Date.UTC().`,
    node,
  )
}

/**
 * Reads the host clock through the guard. Every real-time entry point calls this instead of
 * `Date.now()` directly, so there is exactly one place that can leak the wall clock.
 */
export const hostNow = (expression: string, node: AstNode): number => {
  assertRealTimeAllowed(expression, node)
  return Date.now()
}

export const invokeDateStatic = (name: string, args: Array<unknown>, node: AstNode): number => {
  switch (name) {
    case "now":
      return hostNow("Date.now()", node)
    case "parse":
      return Date.parse(coerceToString(args[0]))
    case "UTC":
      return Date.UTC(...(args.map((arg) => coerceToNumber(arg)) as Parameters<typeof Date.UTC>))
    default:
      throw new InterpreterRuntimeError(`Date.${name} is not available.`, node)
  }
}

export const dateSetterArgumentCount = (name: string): number | undefined => dateSetterArguments.get(name)

export const invokeDateMethod = (
  value: CodeModeDate,
  name: string,
  args: Array<number>,
  node: AstNode,
  initialTime = value.time,
): unknown => {
  const hosted = new Date(initialTime)
  switch (name) {
    case "getTime":
    case "valueOf":
      return value.time
    case "toISOString":
      if (!Number.isFinite(value.time)) throw new InterpreterRuntimeError("Invalid time value.", node).as("RangeError")
      return hosted.toISOString()
    case "toJSON":
      return Number.isFinite(value.time) ? hosted.toISOString() : null
    case "toString":
      return coerceToString(value)
    case "toUTCString":
    case "toGMTString":
      return hosted.toUTCString()
    case "getFullYear":
      return hosted.getFullYear()
    case "getMonth":
      return hosted.getMonth()
    case "getDate":
      return hosted.getDate()
    case "getDay":
      return hosted.getDay()
    case "getHours":
      return hosted.getHours()
    case "getMinutes":
      return hosted.getMinutes()
    case "getSeconds":
      return hosted.getSeconds()
    case "getMilliseconds":
      return hosted.getMilliseconds()
    case "getUTCFullYear":
      return hosted.getUTCFullYear()
    case "getUTCMonth":
      return hosted.getUTCMonth()
    case "getUTCDate":
      return hosted.getUTCDate()
    case "getUTCDay":
      return hosted.getUTCDay()
    case "getUTCHours":
      return hosted.getUTCHours()
    case "getUTCMinutes":
      return hosted.getUTCMinutes()
    case "getUTCSeconds":
      return hosted.getUTCSeconds()
    case "getUTCMilliseconds":
      return hosted.getUTCMilliseconds()
    case "getTimezoneOffset":
      return hosted.getTimezoneOffset()
    case "setTime":
      return updateDate(value, hosted.setTime(args[0]))
    case "setMilliseconds":
      return updateDate(value, hosted.setMilliseconds(args[0]))
    case "setUTCMilliseconds":
      return updateDate(value, hosted.setUTCMilliseconds(args[0]))
    case "setSeconds":
      if (args.length < 2) return updateDate(value, hosted.setSeconds(args[0]))
      return updateDate(value, hosted.setSeconds(args[0], args[1]))
    case "setUTCSeconds":
      if (args.length < 2) return updateDate(value, hosted.setUTCSeconds(args[0]))
      return updateDate(value, hosted.setUTCSeconds(args[0], args[1]))
    case "setMinutes":
      if (args.length < 2) return updateDate(value, hosted.setMinutes(args[0]))
      if (args.length < 3) return updateDate(value, hosted.setMinutes(args[0], args[1]))
      return updateDate(value, hosted.setMinutes(args[0], args[1], args[2]))
    case "setUTCMinutes":
      if (args.length < 2) return updateDate(value, hosted.setUTCMinutes(args[0]))
      if (args.length < 3) return updateDate(value, hosted.setUTCMinutes(args[0], args[1]))
      return updateDate(value, hosted.setUTCMinutes(args[0], args[1], args[2]))
    case "setHours":
      if (args.length < 2) return updateDate(value, hosted.setHours(args[0]))
      if (args.length < 3) return updateDate(value, hosted.setHours(args[0], args[1]))
      if (args.length < 4) return updateDate(value, hosted.setHours(args[0], args[1], args[2]))
      return updateDate(value, hosted.setHours(args[0], args[1], args[2], args[3]))
    case "setUTCHours":
      if (args.length < 2) return updateDate(value, hosted.setUTCHours(args[0]))
      if (args.length < 3) return updateDate(value, hosted.setUTCHours(args[0], args[1]))
      if (args.length < 4) return updateDate(value, hosted.setUTCHours(args[0], args[1], args[2]))
      return updateDate(value, hosted.setUTCHours(args[0], args[1], args[2], args[3]))
    case "setDate":
      return updateDate(value, hosted.setDate(args[0]))
    case "setUTCDate":
      return updateDate(value, hosted.setUTCDate(args[0]))
    case "setMonth":
      if (args.length < 2) return updateDate(value, hosted.setMonth(args[0]))
      return updateDate(value, hosted.setMonth(args[0], args[1]))
    case "setUTCMonth":
      if (args.length < 2) return updateDate(value, hosted.setUTCMonth(args[0]))
      return updateDate(value, hosted.setUTCMonth(args[0], args[1]))
    case "setFullYear":
      if (args.length < 2) return updateDate(value, hosted.setFullYear(args[0]))
      if (args.length < 3) return updateDate(value, hosted.setFullYear(args[0], args[1]))
      return updateDate(value, hosted.setFullYear(args[0], args[1], args[2]))
    case "setUTCFullYear":
      if (args.length < 2) return updateDate(value, hosted.setUTCFullYear(args[0]))
      if (args.length < 3) return updateDate(value, hosted.setUTCFullYear(args[0], args[1]))
      return updateDate(value, hosted.setUTCFullYear(args[0], args[1], args[2]))
    default:
      throw new InterpreterRuntimeError(`Date method '${name}' is not available.`, node)
  }
}

const updateDate = (value: CodeModeDate, time: number): number => {
  value.time = time
  return time
}
