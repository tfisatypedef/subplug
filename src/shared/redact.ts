import type { CommandCategory } from "./types.ts"

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{16,}/g, "$1<redacted>"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_<redacted>"],
  [/sk-[A-Za-z0-9]{16,}/g, "sk-<redacted>"],
  [/AKIA[0-9A-Z]{16}/g, "AKIA<redacted>"],
  [/(?<=\b(?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*)\S+/gi, "<redacted>"],
  [/(--(?:token|password|secret|api-key|apikey)[= ])\S+/gi, "$1<redacted>"],
  [/(\/\/[^/\s:@]+):([^/\s@]+)@/g, "$1:<redacted>@"],
]

export function redactText(value: string): string {
  let out = value
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

export function summarizeCommand(command: string, limit = 140): string {
  const firstLine = command.split(/\r?\n/, 1)[0] ?? ""
  const collapsed = firstLine.replace(/\s+/g, " ").trim()
  const clean = redactText(collapsed)
  if (clean.length <= limit) return clean
  return `${clean.slice(0, limit - 1)}…`
}

export function categorizeCommand(command: string): CommandCategory {
  const value = command.toLowerCase()
  if (/\bgit\b[^\n;|&]*\bcommit\b/.test(value)) return "git-commit"
  if (/\bgit\b[^\n;|&]*\bpush\b/.test(value)) return "git-push"
  if (/(^|[\s;&|])coord\.py\b/.test(value) || /\btools[\\/]coord\b/.test(value)) return "coord"
  if (/(^|[\s;&|])plant\.py\b/.test(value) || /\btools[\\/]plant\b/.test(value)) return "plant"
  if (/\b(pytest|pyright|pylint|black|mypy|ruff|bun test|npm test|vitest|jest)\b/.test(value)) {
    return "test"
  }
  return "other"
}

export function summarizeError(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown"
  const name = "name" in error && typeof error.name === "string" ? error.name : undefined
  if (name) return name
  if ("message" in error && typeof error.message === "string") {
    return redactText(error.message.split(/\r?\n/, 1)[0] ?? "").slice(0, 80)
  }
  return "unknown"
}
