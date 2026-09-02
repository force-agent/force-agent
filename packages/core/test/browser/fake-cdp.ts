import { CdpClient, type CdpParams } from "@opencode-ai/core/browser/cdp/client"
import type { CdpTransport } from "@opencode-ai/core/browser/cdp/transport"

export type Sent = { readonly method: string; readonly params: CdpParams; readonly sessionId?: string }

type Respond = (method: string, params: CdpParams) => CdpParams | undefined | Promise<CdpParams | undefined>

// In-memory CDP wire: records every command, answers each with `respond(method, params)` (an
// empty result by default, possibly async), and lets the test push events as if Chromium had
// sent them.
export function fakeCdp(respond: Respond = () => undefined) {
  const sent: Sent[] = []
  let deliver: (message: string) => void = () => {}
  const transport: CdpTransport = {
    send(message) {
      const parsed = JSON.parse(message) as { id: number; method: string; params: CdpParams; sessionId?: string }
      sent.push({ method: parsed.method, params: parsed.params, sessionId: parsed.sessionId })
      void Promise.resolve(respond(parsed.method, parsed.params)).then((result) =>
        deliver(JSON.stringify({ id: parsed.id, result: result ?? {} })),
      )
    },
    onMessage(listener) {
      deliver = listener
      return () => {}
    },
    onClose() {
      return () => {}
    },
    close() {},
  }
  const client = new CdpClient(transport)
  return {
    client,
    sent,
    emit(method: string, params: CdpParams, sessionId?: string) {
      deliver(JSON.stringify({ method, params, sessionId }))
    },
  }
}
