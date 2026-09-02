import type { Browser } from "@opencode-ai/schema/browser"
import type { CdpClient } from "./cdp/client.js"

export const FETCH_BODY_LIMIT = 512 * 1024
export const EVAL_LIMIT = 256 * 1024
export const DEFAULT_TIMEOUT_MS = 30_000

// Slack added to the CDP-side timeout so the in-page AbortController fires first and the error
// comes back as a readable `{ error }` instead of a protocol timeout.
const CDP_SLACK_MS = 2_000

type Evaluation<T> = {
  result: { value?: T; type?: string; description?: string }
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

export type FetchOutcome = Omit<Browser.FetchResult, "tab">
export type EvalOutcome = Omit<Browser.EvalResult, "tab" | "url">

export class EvaluationError extends Error {}

const literal = (value: unknown) => JSON.stringify(value === undefined ? null : value)

// `fetch(url, init)` executed by the page itself: same origin, cookies, CSRF headers and CSP
// apply exactly as they do to the site's own XHR. Body and headers come back as plain values,
// cut at FETCH_BODY_LIMIT inside the page. Needs no Runtime.enable.
export async function pageFetch(
  client: CdpClient,
  sessionId: string,
  input: Omit<Browser.FetchInput, "tab">,
): Promise<FetchOutcome> {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const expression = `(async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ${literal(timeout)});
  try {
    const response = await fetch(${literal(input.url)}, {
      method: ${literal(input.method ?? "GET")},
      headers: ${literal(input.headers ?? {})},
      body: ${literal(input.body)},
      credentials: "include",
      redirect: "follow",
      signal: controller.signal,
    });
    const text = await response.text();
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    return {
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      headers,
      body: text.length > ${literal(FETCH_BODY_LIMIT)} ? text.slice(0, ${literal(FETCH_BODY_LIMIT)}) : text,
      truncated: text.length > ${literal(FETCH_BODY_LIMIT)},
    };
  } catch (error) {
    const name = error && error.name === "AbortError" ? "Timed out after ${timeout} ms" : String(error && error.message || error);
    return { url: ${literal(input.url)}, status: 0, statusText: "", headers: {}, body: "", truncated: false, error: name };
  } finally {
    clearTimeout(timer);
  }
})()`
  const evaluated = await client.send<Evaluation<FetchOutcome>>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, timeout: timeout + CDP_SLACK_MS },
    sessionId,
  )
  if (evaluated.exceptionDetails) throw new EvaluationError(describe(evaluated.exceptionDetails))
  const value = evaluated.result.value
  if (!value) throw new EvaluationError("fetch returned no value")
  return value
}

// Evaluates `expression` in the page, awaits it, and serializes the result to JSON inside the
// page so EVAL_LIMIT applies before anything crosses CDP. Bare expressions (`document.title`)
// and statement bodies (`const a = 1; return a`) both work: the expression form is parsed
// without running (`new Function` builds it and is never called; `Runtime.compileScript` would
// need Runtime.enable) and the block form is used when it does not parse, so an expression with
// side effects executes exactly once. The page-side timeout races the awaited value, since
// CDP's `timeout` only bounds the synchronous part of an evaluation.
export async function pageEval(
  client: CdpClient,
  sessionId: string,
  input: Omit<Browser.EvalInput, "tab">,
): Promise<EvalOutcome> {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const expression = `(async () => (\n${input.expression}\n))()`
  // Anything but a SyntaxError (a CSP that forbids `new Function`) keeps the expression form.
  const parsed = await client.send<Evaluation<boolean>>(
    "Runtime.evaluate",
    {
      expression: `(() => { try { new Function(${literal(expression)}); return true; } catch (error) { return !(error instanceof SyntaxError); } })()`,
      returnByValue: true,
    },
    sessionId,
  )
  const body = parsed.result.value === false ? `(async () => {\n${input.expression}\n})()` : expression
  const evaluated = await client.send<Evaluation<EvalOutcome>>(
    "Runtime.evaluate",
    { expression: wrapEval(body, timeout), awaitPromise: true, returnByValue: true, timeout: timeout + CDP_SLACK_MS },
    sessionId,
  )
  if (evaluated.exceptionDetails) throw new EvaluationError(describe(evaluated.exceptionDetails))
  const value = evaluated.result.value
  if (!value) throw new EvaluationError("evaluation returned no value")
  return value
}

function wrapEval(inner: string, timeout: number) {
  return `(async () => {
  let __timer;
  const __value = await Promise.race([
    ${inner},
    new Promise((_, reject) => { __timer = setTimeout(() => reject(new Error("Timed out after ${timeout} ms")), ${timeout}); }),
  ]).finally(() => clearTimeout(__timer));
  let __json;
  try { __json = JSON.stringify(__value === undefined ? null : __value); } catch (error) { __json = JSON.stringify(String(__value)); }
  if (__json === undefined) __json = "null";
  return { json: __json.length > ${EVAL_LIMIT} ? __json.slice(0, ${EVAL_LIMIT}) : __json, truncated: __json.length > ${EVAL_LIMIT} };
})()`
}

function describe(details: NonNullable<Evaluation<unknown>["exceptionDetails"]>) {
  const description = details.exception?.description ?? details.text ?? "Evaluation failed"
  return description.split("\n")[0]
}
