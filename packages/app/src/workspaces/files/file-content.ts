import type { FileContent } from "@/runtime/server/types"

const MIME_TYPES = new Map<string, string>([
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["ico", "image/x-icon"],
  ["tif", "image/tiff"],
  ["tiff", "image/tiff"],
  ["heic", "image/heic"],
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["ogg", "audio/ogg"],
  ["m4a", "audio/mp4"],
  ["aac", "audio/aac"],
  ["flac", "audio/flac"],
  ["opus", "audio/opus"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["pdf", "application/pdf"],
])

export function mimeTypeForPath(path: string): string | undefined {
  const ext = path.match(/\.([^./]+)$/)?.[1]?.toLowerCase() ?? ""
  return MIME_TYPES.get(ext)
}

export function isBinaryPath(path: string): boolean {
  return mimeTypeForPath(path) !== undefined
}

export function bytesToBase64(data: Uint8Array): string {
  if (data.length === 0) return ""
  if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
    return Buffer.from(data).toString("base64")
  }
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

export function createFileContent(path: string, data: Uint8Array): FileContent {
  const mimeType = mimeTypeForPath(path)
  if (mimeType) {
    return {
      type: "binary",
      content: bytesToBase64(data),
      encoding: "base64",
      mimeType,
    }
  }
  return {
    type: "text",
    content: new TextDecoder().decode(data),
  }
}

/** Bounded by entries and by approximate bytes so a long browsing session cannot retain every file it opened. */
const MAX_CACHE_ENTRIES = 40
const MAX_CACHE_BYTES = 20 * 1024 * 1024

type CacheEntry = { content: FileContent; bytes: number }

const fileContentCache = new Map<string, CacheEntry>()
let fileContentCacheBytes = 0

function approxCacheBytes(content: FileContent): number {
  return (content.content.length + (content.diff?.length ?? 0)) * 2
}

export function fileContentCacheKey(skillDir: string, path: string): string {
  return `${skillDir}/${path}`
}

export function getFileContentCache(skillDir: string, path: string): FileContent | undefined {
  const key = fileContentCacheKey(skillDir, path)
  const entry = fileContentCache.get(key)
  if (!entry) return undefined
  // Re-insert to mark as most recently used.
  fileContentCache.delete(key)
  fileContentCache.set(key, entry)
  return entry.content
}

export function setFileContentCache(skillDir: string, path: string, content: FileContent): void {
  const key = fileContentCacheKey(skillDir, path)
  const previous = fileContentCache.get(key)
  if (previous) {
    fileContentCache.delete(key)
    fileContentCacheBytes -= previous.bytes
  }
  const bytes = approxCacheBytes(content)
  fileContentCache.set(key, { content, bytes })
  fileContentCacheBytes += bytes
  while (fileContentCache.size > MAX_CACHE_ENTRIES || fileContentCacheBytes > MAX_CACHE_BYTES) {
    const oldest = fileContentCache.keys().next().value
    if (oldest === undefined || oldest === key) break
    const evicted = fileContentCache.get(oldest)
    fileContentCache.delete(oldest)
    fileContentCacheBytes -= evicted?.bytes ?? 0
  }
}

export function invalidateFileContentCache(skillDir: string, path: string): void {
  const key = fileContentCacheKey(skillDir, path)
  const entry = fileContentCache.get(key)
  if (!entry) return
  fileContentCache.delete(key)
  fileContentCacheBytes -= entry.bytes
}

export function clearFileContentCache(): void {
  fileContentCache.clear()
  fileContentCacheBytes = 0
}

export function fileContentCacheStats() {
  return { entries: fileContentCache.size, bytes: fileContentCacheBytes }
}
