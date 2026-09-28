import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

export const LEASE_TIMEOUT_MS = 8000

export class LeaseDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LeaseDeniedError"
  }
}

export type LeaseRequest = {
  repoRoot: string
  holder: string
  sessionID: string
  pid: number
  paths: string[]
}

export type LeaseOutcome =
  | { status: "acquired"; paths: string[] }
  | { status: "denied"; message: string }
  | { status: "skipped"; reason: string }

export function toolLeasePaths(tool: string, args: Record<string, unknown>): string[] {
  if (tool === "edit" || tool === "write") {
    const filePath = args.filePath
    return typeof filePath === "string" && filePath.trim() ? [filePath.trim()] : []
  }
  if (tool === "apply_patch") {
    const patchText = args.patchText
    return typeof patchText === "string" ? parsePatchPaths(patchText) : []
  }
  return []
}

export function parsePatchPaths(patchText: string): string[] {
  const paths = new Set<string>()
  for (const raw of patchText.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim()
    const file = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)
    if (file?.[1]) {
      paths.add(file[1].trim())
      continue
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    if (move?.[1]) paths.add(move[1].trim())
  }
  return [...paths]
}

export function relativeLeasePath(repoRoot: string, filePath: string): string | undefined {
  const absolute = isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath)
  const rel = relative(repoRoot, absolute)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined
  return rel.replace(/\\/g, "/")
}

function pythonCandidates(): string[] {
  return process.platform === "win32" ? ["python", "py"] : ["python3", "python"]
}

function runLock(
  repoRoot: string,
  args: string[],
): { status: number | null; output: string } {
  for (const python of pythonCandidates()) {
    const result = spawnSync(python, args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: LEASE_TIMEOUT_MS,
    })
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") continue
      return { status: null, output: String(result.error) }
    }
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` }
  }
  return { status: null, output: "no python interpreter found" }
}

export function acquireLeases(request: LeaseRequest): LeaseOutcome {
  const script = join(request.repoRoot, "tools", "coord.py")
  if (!existsSync(script)) return { status: "skipped", reason: "no tools/coord.py" }
  const args = [
    script,
    "lock",
    "--root",
    request.repoRoot,
    "--agent",
    request.holder,
    "--session",
    request.sessionID,
    "--pid",
    String(request.pid),
  ]
  for (const path of request.paths) {
    args.push("--path", path)
  }
  const result = runLock(request.repoRoot, args)
  const output = result.output.trim()
  if (result.status === 0) return { status: "acquired", paths: request.paths }
  if (/is leased by/.test(output)) return { status: "denied", message: output }
  return { status: "skipped", reason: output || `coord lock exited ${result.status}` }
}

export async function enforceLeases(request: LeaseRequest): Promise<void> {
  if (!request.paths.length) return
  const outcome = acquireLeases(request)
  if (outcome.status === "denied") throw new LeaseDeniedError(outcome.message)
}
