import { describe, expect, test } from "bun:test"
import { bytesToBase64, createFileContent, isBinaryPath, mimeTypeForPath } from "./file-content"

describe("mimeTypeForPath", () => {
  test.each([
    ["image.png", "image/png"],
    ["photo.PNG", "image/png"],
    ["a/b/c.jpg", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["anim.gif", "image/gif"],
    ["pic.webp", "image/webp"],
    ["vector.svg", "image/svg+xml"],
    ["ICON.SVG", "image/svg+xml"],
    ["photo.avif", "image/avif"],
    ["image.bmp", "image/bmp"],
    ["favicon.ico", "image/x-icon"],
    ["scan.tif", "image/tiff"],
    ["scan.tiff", "image/tiff"],
    ["photo.heic", "image/heic"],
    ["song.mp3", "audio/mpeg"],
    ["sound.wav", "audio/wav"],
    ["audio.ogg", "audio/ogg"],
    ["track.m4a", "audio/mp4"],
    ["clip.aac", "audio/aac"],
    ["music.flac", "audio/flac"],
    ["voice.opus", "audio/opus"],
    ["doc.pdf", "application/pdf"],
  ])("maps %s to %s", (path, mime) => {
    expect(mimeTypeForPath(path)).toBe(mime)
  })

  test.each([
    "file.txt",
    "file.ts",
    "file.json",
    "file.csv",
    "file.md",
    "file.html",
    "file",
    "archive.tar.gz", // last extension gz not mapped
    ".hidden",
    "",
  ])("returns undefined for text/unknown %s", (path) => {
    expect(mimeTypeForPath(path)).toBeUndefined()
  })

  test("is case insensitive and handles paths with dots", () => {
    expect(mimeTypeForPath("DIR/IMAGE.JpG")).toBe("image/jpeg")
    expect(mimeTypeForPath("a.b.c.png")).toBe("image/png")
  })
})

describe("isBinaryPath", () => {
  test("true for media extensions", () => {
    expect(isBinaryPath("photo.png")).toBe(true)
    expect(isBinaryPath("sound.mp3")).toBe(true)
    expect(isBinaryPath("vector.svg")).toBe(true)
    expect(isBinaryPath("image.HEIC")).toBe(true)
  })

  test("false for text extensions", () => {
    expect(isBinaryPath("file.txt")).toBe(false)
    expect(isBinaryPath("file.ts")).toBe(false)
    expect(isBinaryPath("file.csv")).toBe(false)
    expect(isBinaryPath("file")).toBe(false)
    expect(isBinaryPath("")).toBe(false)
  })
})

describe("bytesToBase64", () => {
  test("encodes empty array", () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe("")
  })

  test("encodes known bytes", () => {
    expect(bytesToBase64(new Uint8Array([0, 127, 255]))).toBe("AH//")
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe("aGk=")
  })

  test("round-trips via atob/Buffer", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const b64 = bytesToBase64(data)
    const decoded = Buffer.from(b64, "base64")
    expect(Array.from(decoded)).toEqual(Array.from(data))
  })
})

describe("createFileContent", () => {
  test("creates text content for .ts files", () => {
    const data = new TextEncoder().encode("hello world")
    const result = createFileContent("src/app.ts", data)
    expect(result.type).toBe("text")
    expect(result.content).toBe("hello world")
    expect(result.encoding).toBeUndefined()
    expect(result.mimeType).toBeUndefined()
  })

  test("creates binary content for png with base64", () => {
    const data = new Uint8Array([0, 127, 255])
    const result = createFileContent("image.png", data)
    expect(result.type).toBe("binary")
    expect(result.encoding).toBe("base64")
    expect(result.mimeType).toBe("image/png")
    expect(result.content).toBe("AH//")
  })

  test("creates binary for svg with correct mime", () => {
    const data = new TextEncoder().encode("<svg></svg>")
    const result = createFileContent("icon.svg", data)
    expect(result.type).toBe("binary")
    expect(result.mimeType).toBe("image/svg+xml")
    expect(result.encoding).toBe("base64")
    // content should be base64 of svg string
    expect(result.content).toBe(Buffer.from("<svg></svg>").toString("base64"))
  })

  test("creates binary for audio with correct mime", () => {
    const data = new Uint8Array([1, 2, 3])
    const result = createFileContent("song.mp3", data)
    expect(result.type).toBe("binary")
    expect(result.mimeType).toBe("audio/mpeg")
    expect(result.encoding).toBe("base64")
  })

  test("case insensitive extension", () => {
    const data = new Uint8Array([0])
    const result = createFileContent("PHOTO.JPG", data)
    expect(result.type).toBe("binary")
    expect(result.mimeType).toBe("image/jpeg")
  })

  test("text fallback for unknown extension", () => {
    const data = new TextEncoder().encode("plain text")
    const result = createFileContent("notes.txt", data)
    expect(result.type).toBe("text")
    expect(result.content).toBe("plain text")
  })

  test("text fallback for no extension", () => {
    const data = new TextEncoder().encode("readme")
    const result = createFileContent("Makefile", data)
    expect(result.type).toBe("text")
    expect(result.content).toBe("readme")
  })

  test("handles utf8 text correctly", () => {
    const text = "olá 🌍"
    const data = new TextEncoder().encode(text)
    const result = createFileContent("a.txt", data)
    expect(result.content).toBe(text)
  })
})

import { clearFileContentCache, fileContentCacheStats, getFileContentCache, setFileContentCache } from "./file-content"

describe("file content cache", () => {
  test("evicts the least recently used entry past 40 files and keeps bytes bounded", () => {
    clearFileContentCache()
    for (let index = 0; index < 45; index++) {
      setFileContentCache("/dir", `f${index}.txt`, { type: "text", content: "x".repeat(10) })
    }
    expect(fileContentCacheStats().entries).toBe(40)
    expect(getFileContentCache("/dir", "f0.txt")).toBeUndefined()
    expect(getFileContentCache("/dir", "f44.txt")?.content).toBe("x".repeat(10))

    // A read marks the entry recent, so it survives the next eviction round.
    getFileContentCache("/dir", "f5.txt")
    setFileContentCache("/dir", "extra.txt", { type: "text", content: "y" })
    expect(getFileContentCache("/dir", "f5.txt")).toBeDefined()
    expect(getFileContentCache("/dir", "f6.txt")).toBeUndefined()

    clearFileContentCache()
    setFileContentCache("/dir", "big.txt", { type: "text", content: "z".repeat(11 * 1024 * 1024) })
    setFileContentCache("/dir", "big2.txt", { type: "text", content: "z".repeat(11 * 1024 * 1024) })
    expect(fileContentCacheStats().entries).toBe(1)
    clearFileContentCache()
  })
})
