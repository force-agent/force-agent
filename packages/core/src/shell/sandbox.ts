import { statSync } from "fs"

/**
 * bubblewrap argv for a sandboxed shell: the whole filesystem read-only, the
 * project directory writable, private /tmp, /dev and /proc, own pid namespace,
 * and the child dies with the server. Network stays shared: agents fetch and
 * install things. Pure so it can be unit-tested without bwrap installed.
 */
export function sandboxArgs(input: { cwd: string; shell: string; args: readonly string[] }): string[] {
  return [
    "--ro-bind",
    "/",
    "/",
    "--bind",
    input.cwd,
    input.cwd,
    "--tmpfs",
    "/tmp",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--chdir",
    input.cwd,
    "--unshare-pid",
    "--die-with-parent",
    input.shell,
    ...input.args,
  ]
}

export function resolveBwrap(): string | undefined {
  try {
    const which = (globalThis as unknown as { Bun?: { which?: (bin: string) => string | null } }).Bun?.which
    if (which) {
      const found = which("bwrap")
      if (found) return found
    }
  } catch {}
  for (const candidate of ["/usr/bin/bwrap", "/bin/bwrap"]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return undefined
}

export class SandboxUnavailableError extends Error {
  constructor() {
    super(
      "LABHARNESS_SANDBOX=1 requires bubblewrap (`bwrap`) on PATH and a Linux host; refusing to run the command unsandboxed",
    )
    this.name = "SandboxUnavailableError"
  }
}
