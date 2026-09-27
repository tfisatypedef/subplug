import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export function findRepoRoot(startDir: string): string | undefined {
  let current = resolve(startDir)
  while (true) {
    if (existsSync(join(current, ".git"))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export function isCoordinationEnabled(repoRoot: string): boolean {
  return existsSync(join(repoRoot, "coordination"))
}
