import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"

const NPM_EXE = join("node_modules", "@opencode", "cli", "bin", "opencode.exe")

export function pickOpencodeBin(
  candidates: string[],
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  for (const candidate of candidates) {
    if (platform !== "win32") return candidate
    if (candidate.toLowerCase().endsWith(".exe")) return candidate
    const exe = join(dirname(candidate), NPM_EXE)
    if (existsSync(exe)) return exe
  }
  return undefined
}

export function resolveOpencodeBin(): string {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN
  const which = process.platform === "win32" ? "where.exe" : "which"
  // v2 ships the `opencode2` bin alongside `opencode`; prefer it so a v1
  // install on PATH does not shadow the host this branch targets.
  for (const name of ["opencode2", "opencode"]) {
    const probe = spawnSync(which, [name], { encoding: "utf8" })
    const lines = (probe.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const picked = pickOpencodeBin(lines)
    if (picked) return picked
  }
  return process.platform === "win32" ? "opencode2.exe" : "opencode2"
}
