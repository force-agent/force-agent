import { describe, expect, test } from "bun:test"
import { sandboxArgs } from "../../src/shell/sandbox"

describe("sandboxArgs", () => {
  test("binds the project directory read-write inside a read-only root", () => {
    const args = sandboxArgs({ cwd: "/work/repo", shell: "/bin/bash", args: ["-c", "git status"] })
    const bind = args.indexOf("--bind")
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"])
    expect(args.slice(bind, bind + 3)).toEqual(["--bind", "/work/repo", "/work/repo"])
    expect(args).toContain("--chdir")
    expect(args).toContain("--die-with-parent")
    expect(args.slice(-3)).toEqual(["/bin/bash", "-c", "git status"])
  })

  test("never unshares the network: agents install and fetch", () => {
    expect(sandboxArgs({ cwd: "/w", shell: "sh", args: [] })).not.toContain("--unshare-net")
  })
})
