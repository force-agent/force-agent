import { convertHTMLToMarkdown } from "../tool/html-markdown.js"
import type { CdpClient } from "./cdp/client.js"

export const PAGE_CHARS = 16_000

// `DOM.getOuterHTML` of the first match for `selector` (default `main`, then `body`), converted
// with the same html-markdown pipeline as webfetch and cut into fixed-size pages.
export async function read(
  client: CdpClient,
  sessionId: string,
  input: { readonly selector?: string; readonly page?: number },
) {
  const document = await client.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 }, sessionId)
  const query = (selector: string) =>
    client
      .send<{ nodeId: number }>("DOM.querySelector", { nodeId: document.root.nodeId, selector }, sessionId)
      .then((result) => result.nodeId)
      .catch(() => 0)
  const nodeId = (await query(input.selector ?? "main")) || (await query("body"))
  if (!nodeId) throw new Error(`Selector not found: ${input.selector ?? "main"}`)
  const html = await client.send<{ outerHTML: string }>("DOM.getOuterHTML", { nodeId }, sessionId)
  const markdown = convertHTMLToMarkdown(html.outerHTML)
  const pages = Math.max(1, Math.ceil(markdown.length / PAGE_CHARS))
  const page = Math.min(Math.max(1, input.page ?? 1), pages)
  return { markdown: markdown.slice((page - 1) * PAGE_CHARS, page * PAGE_CHARS), page, pages }
}
