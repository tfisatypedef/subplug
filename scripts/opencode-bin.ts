import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

export function resolveOpencodeBin(): string {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN
  const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["opencode"], {
    encoding: "utf8",
  })
  for (const raw of (probe.stdout ?? "").split(/\r?\n/)) {
    const candidate = raw.trim()
    if (!candidate) continue
    if (candidate.toLowerCase().endsWith(".exe")) return candidate
    const exe = join(dirname(candidate), "node_modules", "opencode-ai", "bin", "opencode.exe")
    if (existsSync(exe)) return exe
  }
  return process.platform === "win32" ? "opencode.exe" : "opencode"
}
