import { spawnSync } from "node:child_process"

export function resolveOpencodeBin(): string {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN
  const which = process.platform === "win32" ? "where.exe" : "which"
  // v2 ships the `opencode2` bin alongside `opencode`; prefer it so a v1
  // install on PATH does not shadow the host this branch targets.
  for (const name of ["opencode2", "opencode"]) {
    const probe = spawnSync(which, [name], { encoding: "utf8" })
    const candidate = (probe.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    if (candidate) return candidate
  }
  return process.platform === "win32" ? "opencode2.exe" : "opencode2"
}
