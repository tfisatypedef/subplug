import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolveOpencodeBin } from "./opencode-bin.ts"

export type Version = { major: number; minor: number; patch: number }

export function parseVersion(value: string): Version | undefined {
  const match = value
    .trim()
    .replace(/^opencode\s+/i, "")
    .match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/** Nightly/dev hosts report 0.0.0-dev-<n>; they are still v2 line builds. */
export function isDevHost(value: string): boolean {
  return /^(?:opencode\s+)?v?0\.0\.0-dev-\d+$/i.test(value.trim())
}

export function atLeast(version: Version, minimum: Version): boolean {
  if (version.major !== minimum.major) return version.major > minimum.major
  if (version.minor !== minimum.minor) return version.minor > minimum.minor
  return version.patch >= minimum.patch
}

export function satisfiesRange(version: Version, range: string): boolean {
  const trimmed = range.trim()
  const minimum = parseVersion(trimmed.replace(/^[\^~>=<\s]+/, ""))
  if (!minimum) return false
  if (trimmed.startsWith("^")) return version.major === minimum.major && atLeast(version, minimum)
  if (trimmed.startsWith(">=")) return atLeast(version, minimum)
  return version.major === minimum.major && version.minor === minimum.minor && version.patch === minimum.patch
}

function fail(message: string): never {
  process.stderr.write(`[canary] FAIL ${message}\n`)
  process.exit(1)
}

function info(message: string): void {
  process.stdout.write(`[canary] ${message}\n`)
}

function main(): void {
  const root = join(import.meta.dir, "..")
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version?: string
    dependencies?: Record<string, string>
  }
  const declared = pkg.dependencies?.["@opencode/plugin"]
  if (!declared) fail("@opencode/plugin is not declared in package.json dependencies")

  let installed = "not installed"
  try {
    const pluginPkg = JSON.parse(
      readFileSync(join(root, "node_modules", "@opencode", "plugin", "package.json"), "utf8"),
    ) as { version?: string }
    installed = pluginPkg.version ?? installed
  } catch {
    // fall through to the check below
  }
  const installedVersion = parseVersion(installed)
  if (!installedVersion) fail(`@opencode/plugin is not installed (declare ${declared})`)
  if (installedVersion.major !== 2) {
    fail(`@opencode/plugin ${installed} is not on the v2 line; this branch targets v2`)
  }

  const bin = resolveOpencodeBin()
  const run = spawnSync(bin, ["--version"], { encoding: "utf8" })
  if (run.error) fail(`cannot run ${bin}: ${run.error.message}`)
  if ((run.status ?? 1) !== 0) fail(`${bin} --version exited with ${run.status}`)
  const hostText = `${run.stdout ?? ""}`.trim()
  const host = parseVersion(hostText)

  info(`subplug ${pkg.version ?? "?"}; @opencode/plugin declared ${declared}, installed ${installed}`)
  info(`opencode ${hostText || "?"} at ${bin}`)

  if (isDevHost(hostText)) {
    info("dev host build detected; skipping the release range check")
  } else {
    if (!host) fail(`unparseable version output: ${JSON.stringify(hostText)}`)
    if (host.major < 2) fail(`opencode ${hostText} is not v2; install opencode2 or set OPENCODE_BIN`)
    if (!satisfiesRange(host, declared)) {
      fail(`opencode ${hostText} does not satisfy ${declared}; update the plugin before shipping`)
    }
    if (installedVersion.major !== host.major) {
      fail(`@opencode/plugin ${installed} is not on the host line ${host.major}`)
    }
    if (installedVersion.minor !== host.minor) {
      info(`warn installed plugin API ${installed} differs from the host minor ${host.minor}`)
    } else {
      info("installed plugin API matches the host line")
    }
  }

  if (process.argv.includes("--load")) {
    info("running the TUI load harness")
    const load = spawnSync("bun", ["run", join(root, "scripts", "dev-harness.ts"), "--tui"], { stdio: "inherit" })
    if ((load.status ?? 1) !== 0) fail(`TUI load harness exited with ${load.status}`)
  }

  info("OK")
}

if (import.meta.main) main()
