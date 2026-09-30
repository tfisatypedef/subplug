import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readEventRecords, EventLog } from "../src/hub/append.ts"
import { foldSessions } from "../src/hub/fold.ts"
import { joinClaimsToSessions, readMonitorState } from "../src/hub/monitor.ts"
import type { EventRecord } from "../src/shared/types.ts"
import { resolveOpencodeBin } from "./opencode-bin.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
// Load a packed/extracted copy instead of the repo when set; used by the
// packed-artifact smoke check so the shipped file set is what gets loaded.
const pluginDir = process.env.SUBPLUG_HARNESS_PLUGIN ?? root
// Keep the workspace outside the plugin repo: v2 watches local plugin sources,
// and harness state writes inside the repo would retrigger plugin reloads.
const harnessDir = process.env.SUBPLUG_HARNESS_DIR ?? join(tmpdir(), "subplug-harness")
const repoDir = join(harnessDir, "repo")
const configDir = join(harnessDir, "config")
const stateDir = join(harnessDir, "state")
const pointerFile = join(harnessDir, "xdg", "state", "opencode", "subplug", "hub.json")
const probeStateEntry = join(root, "scripts", "probe-tui-state")
const port = process.env.SUBPLUG_HARNESS_PORT
  ? Number(process.env.SUBPLUG_HARNESS_PORT)
  : 4100 + Math.floor(Math.random() * 900)
const host = process.env.SUBPLUG_HARNESS_HOST ?? "127.0.0.1"
const connectHost = process.env.SUBPLUG_HARNESS_CONNECT ?? host
const base = `http://${connectHost}:${port}`
const password = process.env.SUBPLUG_HARNESS_PASSWORD ?? "subplug-harness"
const authHeaders = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
const keep = process.argv.includes("--keep")
const tuiOnly = process.argv.includes("--tui")
const demoMode = process.argv.includes("--demo")
const pokeRisk = process.argv.includes("--poke-risk")
const inspectMode = process.argv.includes("--inspect")
const expectSubagent = process.argv.includes("--expect-subagent")
const probeTuiState = process.argv.includes("--probe-tui-state")
const attachMode = process.argv.includes("--attach")
const existingServerMode = process.argv.includes("--existing-server")
const probeExecute = process.argv.includes("--probe-execute")
const probeTask = process.argv.includes("--probe-task")
const probeReplay = process.argv.includes("--probe-replay")
const verbose = process.argv.includes("--verbose")

const harnessIdentity = `Harness Agent@${hostname()}`
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

function log(message: string): void {
  process.stdout.write(`[harness] ${message}\n`)
}

function seedRepo(): void {
  rmSync(repoDir, { recursive: true, force: true })
  mkdirSync(join(repoDir, "coordination", "claims"), { recursive: true })
  mkdirSync(join(repoDir, "src"), { recursive: true })
  writeFileSync(join(repoDir, "src", "app.py"), "print('hello')\n")
  writeFileSync(join(repoDir, "README.md"), "# harness repo\n")
  const claim = {
    event_id: "harness-claim-event",
    kind: "claim",
    agent: harnessIdentity,
    issued: "2026-09-27T10:00:00Z",
    expires: "2099-01-01T00:00:00Z",
    claim_id: "claim-harness-0001",
    note: "seeded by dev-harness",
    scopes: { patterns: ["src/**"], files: ["src/app.py"], docs: [], evidence: [], baton: null },
  }
  writeFileSync(join(repoDir, "coordination", "claims", "harness.jsonl"), `${JSON.stringify(claim)}\n`)
  spawnSync("git", ["init", "-q"], { cwd: repoDir })
  spawnSync("git", ["config", "user.name", "Harness Agent"], { cwd: repoDir })
  spawnSync("git", ["config", "user.email", "harness@testhost"], { cwd: repoDir })
  spawnSync("git", ["add", "-A"], { cwd: repoDir })
  spawnSync("git", ["commit", "-q", "-m", "harness seed"], { cwd: repoDir })
}

function seedConflictingClaim(): void {
  const claim = {
    event_id: "demo-other-claim",
    kind: "claim",
    agent: `other@${hostname()}`,
    issued: "2026-09-27T10:05:00Z",
    expires: "2099-01-01T00:00:00Z",
    claim_id: "claim-demo-other",
    note: "seeded conflict for the demo",
    scopes: { patterns: ["src/**"], files: ["src/app.py"], docs: [], evidence: [], baton: null },
  }
  writeFileSync(join(repoDir, "coordination", "claims", "other.jsonl"), `${JSON.stringify(claim)}\n`)
}

function writeConfig(extraPlugins: unknown[] = []): void {
  mkdirSync(configDir, { recursive: true })
  const config = {
    $schema: "https://opencode.ai/config.json",
    permission: {
      bash: "allow",
      edit: "allow",
      external_directory: "allow",
      webfetch: "deny",
      question: "deny",
    },
    plugins: [
      { package: pluginDir, options: { coord: { injectIdentity: true }, storageDir: stateDir } },
      ...extraPlugins,
    ],
  }
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify(config, null, 2))
  // The TUI entry reads its own `cli.json`; plugin options do not otherwise
  // reach it from opencode.json.
  const cliConfig = {
    $schema: "https://opencode.ai/v2/cli.json",
    plugins: [{ package: pluginDir, options: { storageDir: stateDir } }, ...extraPlugins],
  }
  writeFileSync(join(configDir, "cli.json"), JSON.stringify(cliConfig, null, 2))
}

function harnessEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    XDG_STATE_HOME: join(harnessDir, "xdg", "state"),
    XDG_DATA_HOME: join(harnessDir, "xdg", "data"),
    XDG_CACHE_HOME: join(harnessDir, "xdg", "cache"),
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_PASSWORD: password,
    SUBPLUG_STORAGE_DIR: stateDir,
    ...extra,
  }
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...authHeaders },
    signal: AbortSignal.timeout(30_000),
  })
}

async function waitForServer(timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let lastError = "no response"
  while (Date.now() < deadline) {
    try {
      const response = await api("/api/info", { signal: AbortSignal.timeout(2500) } as RequestInit)
      if (response.ok) return (await response.json()) as Record<string, unknown>
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = String(error)
    }
    await sleep(400)
  }
  throw new Error(`server did not become ready: ${lastError}`)
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out)
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out)
  }
  return out
}

function hubRoots(): string[] {
  const baseDir = join(stateDir, "subplug")
  if (!existsSync(baseDir)) return []
  return readdirSync(baseDir)
    .map((name) => join(baseDir, name))
    .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true)
}

function hubDirsByRecency(): string[] {
  return hubRoots().sort((left, right) => latestMtime(right) - latestMtime(left))
}

function latestMtime(dir: string): number {
  let latest = 0
  for (const name of readdirSync(dir)) {
    try {
      const value = statSync(join(dir, name)).mtimeMs
      if (value > latest) latest = value
    } catch {
      // ignore unreadable entries
    }
  }
  return latest
}

function readEvents(dir: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("events.") || !name.includes(".jsonl")) continue
    for (const line of readFileSync(join(dir, name), "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // ignore malformed harness input
      }
    }
  }
  return events.sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0))
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(250)
  }
  log(`timeout waiting for ${label}`)
  return false
}

async function forcePluginActivation(timeoutMs = 120_000): Promise<Record<string, unknown> | undefined> {
  // The v2 host activates local plugins lazily; asking for the inventory first
  // forces resolution and setup, so the event tap is live before sessions exist.
  let entry: Record<string, unknown> | undefined
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !entry) {
    const response = await api("/api/plugin")
    if (response.ok) {
      const payload = (await response.json()) as { data?: Array<Record<string, unknown>> }
      entry = (payload.data ?? []).find((item) => item.id === "subplug")
    }
    if (!entry) await sleep(500)
  }
  return entry
}

function stop(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    return
  }
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL")
    } catch {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
    }
  }, 2000).unref()
}

function killStaleServer(): void {
  if (process.platform === "win32") return
  const listing = spawnSync("ss", ["-ltnp"], { encoding: "utf8" }).stdout ?? ""
  const line = listing.split(/\r?\n/).find((entry) => entry.includes(`:${port} `))
  const pid = line ? /pid=(\d+)/.exec(line)?.[1] : undefined
  if (pid) {
    log(`killing stale listener on port ${port} (pid ${pid})`)
    spawnSync("kill", ["-9", pid])
  }
}

function spawnServer(logLevel: string): { child: ChildProcess; output: () => string } {
  const bin = resolveOpencodeBin()
  const child = spawn(bin, ["serve", "--hostname", host, "--port", String(port), "--print-logs", "--log-level", logLevel.toLowerCase()], {
    cwd: repoDir,
    env: harnessEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  })
  let output = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
    if (verbose) process.stdout.write(chunk)
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
    if (verbose) process.stderr.write(chunk)
  })
  return { child, output: () => output }
}

async function startServerUntilReady(attempts = 3): Promise<{ child: ChildProcess; output: () => string }> {
  let last: { child: ChildProcess; output: () => string } | undefined
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    killStaleServer()
    last = spawnServer("INFO")
    try {
      const info = await waitForServer(45_000)
      log(`server ready (attempt ${attempt}): ${JSON.stringify(info).slice(0, 200)}`)
      return last
    } catch (error) {
      log(`server attempt ${attempt} failed: ${String(error)}`)
      stop(last.child)
      await sleep(1500)
    }
  }
  throw new Error("server did not become ready after retries")
}

function spawnTui(
  extraEnv: Record<string, string> = {},
  options: { serverURL?: string } = {},
): { child: ChildProcess; output: () => string } {
  const bin = resolveOpencodeBin()
  // Attach mode connects to an already-running server; standalone starts a
  // private one. `--print-logs` requires standalone, so it is omitted on attach.
  const cliArgs = options.serverURL ? ["--server", options.serverURL] : ["--standalone", "--print-logs"]
  const child =
    process.platform === "win32"
      ? spawn(bin, cliArgs, {
          cwd: repoDir,
          env: harnessEnv(extraEnv),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        })
      : spawn("script", ["-qec", `'${bin}' ${cliArgs.join(" ")}`, "/dev/null"], {
          cwd: repoDir,
          env: harnessEnv(extraEnv),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: true,
        })
  let output = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })
  return { child, output: () => output }
}

function launchInstructions(): void {
  log("launch the TUI:")
  log(`  POSIX:      export OPENCODE_CONFIG_DIR="${configDir}"; opencode2`)
  log("  then type /subplug for the dashboard; sidebar shows the Agents slot")
  log("  second terminal: bun run scripts/dev-harness.ts --poke-risk   (toast demo)")
}

function seedDemoHub(hubDir: string): void {
  const eventLog = new EventLog(hubDir, `demo-${Math.random().toString(16).slice(2, 8)}`)
  const now = Date.now()
  const rootID = "ses_demo00000001root"
  const childID = "ses_demo00000002chld"
  const push = (record: EventRecord) => eventLog.append(record)
  const serverID = eventLog.serverID

  push({ ts: now - 120_000, serverID, kind: "server.start", summary: "demo seed" })
  push({
    ts: now - 90_000,
    serverID,
    sessionID: rootID,
    kind: "session.created",
    refs: { title: "plan the release", directory: repoDir, parentID: null },
  })
  push({ ts: now - 89_000, serverID, sessionID: rootID, kind: "session.agent", refs: { agent: "build" } })
  push({ ts: now - 88_000, serverID, sessionID: rootID, kind: "session.model", refs: { model: "demo/model" } })
  push({ ts: now - 80_000, serverID, sessionID: rootID, kind: "session.identity", refs: { identity: harnessIdentity } })
  push({ ts: now - 50_000, serverID, sessionID: rootID, kind: "session.status", refs: { status: "busy" } })
  push({
    ts: now - 45_000,
    serverID,
    sessionID: childID,
    parentID: rootID,
    kind: "session.created",
    refs: { title: "verify claims", parentID: rootID },
  })
  push({
    ts: now - 44_000,
    serverID,
    sessionID: childID,
    kind: "session.identity",
    refs: { identity: `${harnessIdentity}/${childID}` },
  })
  push({ ts: now - 30_000, serverID, sessionID: childID, kind: "session.idle" })
  push({
    ts: now - 20_000,
    serverID,
    sessionID: rootID,
    kind: "command",
    summary: 'git commit -m "demo"',
    refs: { category: "git-commit", source: "bash" },
  })
  push({
    ts: now - 15_000,
    serverID,
    sessionID: rootID,
    kind: "command.risk",
    summary: "2 uncovered staged path(s) for git-commit",
    refs: { category: "git-commit", uncovered: 2, detail: "docs/notes.md: no active claim" },
  })
  push({
    ts: now - 10_000,
    serverID,
    sessionID: childID,
    kind: "comms.sent",
    summary: "please re-run the claim coverage check",
    refs: {
      msgID: "msg_demo_inbox_0001",
      to: childID,
      from: harnessIdentity,
      kind: "message",
      delivery: "queue",
    },
  })
}

async function runDemo(): Promise<void> {
  seedRepo()
  seedConflictingClaim()
  writeConfig()
  rmSync(stateDir, { recursive: true, force: true })

  const { child, output } = spawnServer("error")
  try {
    await waitForServer(120_000)
    await forcePluginActivation()
    const ready = await waitFor(() => hubRoots().length > 0, 20_000, "hub directory")
    const hubDir = hubRoots()[0]
    if (!ready || !hubDir) throw new Error("hub directory was not created")
    seedDemoHub(hubDir)
    log(`demo hub seeded: ${hubDir}`)
  } catch (error) {
    process.stderr.write(output().slice(-3000))
    throw error
  } finally {
    stop(child)
    await sleep(500)
  }
  launchInstructions()
}

function runPokeRisk(): void {
  const dirs = hubDirsByRecency()
  if (!dirs.length) {
    log("no hub found; run `bun run scripts/dev-harness.ts --demo --keep` first")
    process.exit(1)
  }
  const dir = dirs[0]!
  const eventLog = new EventLog(dir, `poke-${Math.random().toString(16).slice(2, 8)}`)
  eventLog.append({
    ts: Date.now(),
    serverID: eventLog.serverID,
    sessionID: "ses_demo00000001root",
    kind: "command.risk",
    summary: "2 uncovered staged path(s) for git-commit",
    refs: { category: "git-commit", uncovered: 2, detail: "poked by dev-harness" },
  })
  log(`poked command.risk into ${dir} (expect a toast if the TUI is open)`)
}

function runInspect(): void {
  const dirs = hubDirsByRecency()
  if (!dirs.length) {
    log("no hub found; run `--demo` or the server spike first")
    process.exit(1)
  }
  let taskChild: { sessionID: string; parentID: string; agent: string } | undefined
  for (const dir of dirs) {
    const state = readMonitorState(dir, repoDir)
    log(`hub ${dir}`)
    log(`sessions: ${state.sessions.length}`)
    for (const session of state.sessions) {
      if (!taskChild && session.kind === "subagent" && session.parentID && session.agent) {
        taskChild = { sessionID: session.sessionID, parentID: session.parentID, agent: session.agent }
      }
      log(
        `  [${session.kind}] ${session.sessionID} parent=${session.parentID ?? "-"} identity=${session.identity ?? "-"} status=${session.status} agent=${session.agent ?? "-"} title=${session.title ?? "-"}`,
      )
    }
    const holders = joinClaimsToSessions(state.registry, state.sessions)
    log(`claims: ${holders.length} active, ${state.registry.conflicts.length} conflict(s), ${state.registry.errors.length} error(s)`)
    for (const { claim, session } of holders) {
      const baton = claim.scopes.baton ? ` baton=${claim.scopes.baton}` : ""
      const joined = session ? ` ⇄ ${session.sessionID}` : " (no session)"
      log(`  ${claim.claimID} ${claim.agent}${baton}${joined}`)
    }
    for (const risk of state.risks) {
      log(`  risk[${risk.category}] ${risk.summary}`)
    }
  }
  if (expectSubagent) {
    if (taskChild) {
      log(`PASS: task subagent ${taskChild.sessionID} parent=${taskChild.parentID} agent=${taskChild.agent}`)
      return
    }
    process.stderr.write("[harness] FAIL: no subagent with a recovered parent/agent pair found\n")
    process.exit(1)
  }
}

async function runTuiCheck(): Promise<void> {
  seedRepo()
  writeConfig()
  rmSync(stateDir, { recursive: true, force: true })
  const { child, output } = spawnTui()
  const marker = join(stateDir, "subplug", "tui-plugin-loaded.json")
  const loaded = await waitFor(() => existsSync(marker), 90_000, "tui plugin marker")
  stop(child)
  await sleep(500)
  if (loaded) {
    log(`TUI plugin loaded: ${readFileSync(marker, "utf8").trim()}`)
    log("slot: sidebar Agents (append to sidebar.content); route/command: /subplug")
    log("TUI check OK")
    return
  }
  process.stderr.write(output().slice(-4000))
  log("TUI marker was not written; run interactively:")
  log(`  set OPENCODE_CONFIG_DIR=${configDir}`)
  log("  opencode2")
  process.exit(1)
}

async function runTuiStateProbe(): Promise<void> {
  if (existingServerMode) {
    await runExistingServerProbe()
    return
  }
  seedRepo()
  writeConfig([{ package: probeStateEntry, options: {} }])
  rmSync(stateDir, { recursive: true, force: true })
  const probeDir = join(stateDir, "probe")

  let server: ChildProcess | undefined
  let serverOutput = () => ""
  let serverURL: string | undefined
  if (attachMode) {
    const started = await startServerUntilReady()
    server = started.child
    serverOutput = started.output
    const seeded = await createSession("probe root (server-seeded)")
    log(`attached mode: server ready at ${base}; seeded ${seeded}`)
    serverURL = base
  }

  const { child, output } = spawnTui({
    SUBPLUG_PROBE_DIR: probeDir,
    SUBPLUG_PROBE_EXECUTE: probeExecute || probeTask ? "1" : "0",
    SUBPLUG_PROBE_TASK: probeTask ? "1" : "0",
    SUBPLUG_PROBE_PLUGIN_VERSION: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string,
  }, { serverURL })
  const marker = join(probeDir, "tui-state-probe.json")
  const done = await waitFor(() => existsSync(marker), 90_000, "tui state probe marker")
  stop(child)
  if (server) stop(server)
  await sleep(500)

  if (done) {
    const report = JSON.parse(readFileSync(marker, "utf8")) as { outcome?: string }
    log(`TUI state probe (${attachMode ? "attach" : "standalone"}): \n${JSON.stringify(report, null, 2)}`)
    if (!keep && !probeExecute) rmSync(harnessDir, { recursive: true, force: true })
    if (probeExecute) log(`execution evidence retained at ${marker}`)
    if (report.outcome !== "pass") {
      process.exitCode = 1
      return
    }
    log("TUI state probe OK")
    return
  }

  process.stderr.write(output().slice(-4000))
  if (serverOutput()) process.stderr.write(serverOutput().slice(-4000))
  log("TUI state probe marker was not written")
  process.exit(1)
}

async function runExistingServerProbe(): Promise<void> {
  const rawURL = process.env.SUBPLUG_PROBE_SERVER_URL
  const secret = process.env.OPENCODE_PASSWORD
  if (!rawURL || !secret) {
    throw new Error("--existing-server requires SUBPLUG_PROBE_SERVER_URL and OPENCODE_PASSWORD")
  }
  const endpoint = new URL(rawURL)
  if (endpoint.username || endpoint.password || !["http:", "https:"].includes(endpoint.protocol)) {
    throw new Error("SUBPLUG_PROBE_SERVER_URL must be an HTTP(S) URL without embedded credentials")
  }
  const serverURL = endpoint.origin
  log("existing-server probe will create two named sessions and admit one scratch prompt on the server")
  if (probeExecute) log("execution mode will run that prompt with the selected model")
  const response = await fetch(`${serverURL}/api/info`, {
    headers: { authorization: `Basic ${Buffer.from(`opencode:${secret}`).toString("base64")}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`existing server /api/info returned HTTP ${response.status}`)

  // This directory belongs only to the client. No server workspace, server
  // configuration, or existing state tree is ever seeded, cleared, or stopped.
  const clientDir = mkdtempSync(join(tmpdir(), "subplug-probe-client-"))
  const clientConfig = join(clientDir, "config")
  const probeDir = join(clientDir, "probe")
  mkdirSync(clientConfig, { recursive: true })
  writeFileSync(join(clientConfig, "cli.json"), JSON.stringify({
    plugins: [{ package: root, options: { remote: "auto" } }, { package: probeStateEntry }],
  }, null, 2))
  const bin = resolveOpencodeBin()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_CONFIG_DIR: clientConfig,
    OPENCODE_PASSWORD: secret,
    XDG_STATE_HOME: join(clientDir, "state"),
    XDG_DATA_HOME: join(clientDir, "data"),
    XDG_CACHE_HOME: join(clientDir, "cache"),
    SUBPLUG_PROBE_DIR: probeDir,
    SUBPLUG_PROBE_EXECUTE: probeExecute || probeTask ? "1" : "0",
    SUBPLUG_PROBE_TASK: probeTask ? "1" : "0",
    SUBPLUG_PROBE_PLUGIN_VERSION: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string,
  }
  delete env.SUBPLUG_STORAGE_DIR
  delete env.SUBPLUG_HUB_GROUP
  const child = process.platform === "win32"
    ? spawn(bin, ["--server", serverURL], {
        cwd: clientDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    : spawn("script", [
        "-qec",
        [bin, "--server", serverURL].map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" "),
        "/dev/null",
      ], {
        cwd: clientDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: true,
      })
  let outputBytes = 0
  child.stdout?.on("data", (chunk: Buffer) => { outputBytes += chunk.length })
  child.stderr?.on("data", (chunk: Buffer) => { outputBytes += chunk.length })
  const marker = join(probeDir, "tui-state-probe.json")
  log(`client config: ${clientConfig}`)
  log("client launch: set OPENCODE_PASSWORD in the environment, then run:")
  const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`
  if (process.platform === "win32") {
    log(`  $env:OPENCODE_CONFIG_DIR = ${quoted(clientConfig)}; & ${quoted(bin)} --server ${quoted(serverURL)}`)
  } else {
    const shellQuoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    log(`  OPENCODE_CONFIG_DIR=${shellQuoted(clientConfig)} ${shellQuoted(bin)} --server ${shellQuoted(serverURL)}`)
  }
  const probeTimeout = Math.max(5_000, Math.min(180_000, Number(env.SUBPLUG_PROBE_TIMEOUT_MS) || 90_000))
  const done = await waitFor(() => existsSync(marker) || child.exitCode !== null, probeTimeout + 20_000, "existing-server probe")
  stop(child)
  await sleep(500)
  if (!done || !existsSync(marker)) {
    throw new Error(`client probe did not write a result (exit=${child.exitCode ?? "timeout"}, logBytes=${outputBytes}); client files retained at ${clientDir}`)
  }
  const report = JSON.parse(readFileSync(marker, "utf8")) as {
    outcome?: string
    errors?: string[]
    serverPluginLoaded?: boolean
    clientPluginLoaded?: boolean
  }
  const clientMarker = join(clientDir, "state", "opencode", "subplug", "tui-plugin-loaded.json")
  let serverLoaded = false
  try {
    const pluginResponse = await fetch(`${serverURL}/api/plugin`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${secret}`).toString("base64")}` },
      signal: AbortSignal.timeout(10_000),
    })
    const pluginPayload = pluginResponse.ok
      ? (await pluginResponse.json()) as { data?: Array<{ id?: string; state?: { status?: string }; features?: { server?: boolean } }> }
      : undefined
    const serverPlugin = pluginPayload?.data?.find((entry) => entry.id === "subplug")
    serverLoaded = serverPlugin?.state?.status === "active" && serverPlugin.features?.server === true
  } catch {
    report.errors = [...(report.errors ?? []), "server plugin inventory unavailable"]
  }
  const clientLoaded = existsSync(clientMarker)
  report.serverPluginLoaded = serverLoaded
  report.clientPluginLoaded = clientLoaded
  if (!serverLoaded || !clientLoaded) {
    report.outcome = "fail"
    if (!serverLoaded) report.errors = [...(report.errors ?? []), "subplug server plugin was not confirmed active"]
    if (!clientLoaded) report.errors = [...(report.errors ?? []), "subplug TUI plugin marker was not found"]
  }
  writeFileSync(marker, `${JSON.stringify(report, null, 2)}\n`)
  log(`probe report: ${marker}`)
  log(JSON.stringify(report, null, 2))
  if (report.outcome !== "pass") {
    process.exitCode = 1
  } else {
    // Keep redacted evidence for the two-device acceptance record, even on pass.
    log(`client evidence retained at ${clientDir}`)
  }
}

async function createSession(title: string, parentID?: string): Promise<string> {
  const response = await api("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, ...(parentID ? { parentID } : {}) }),
  })
  if (!response.ok) throw new Error(`POST /api/session -> HTTP ${response.status}: ${await response.text()}`)
  const payload = (await response.json()) as { data?: { id?: string } }
  const id = payload.data?.id
  if (!id) throw new Error("POST /api/session returned no id")
  return id
}

async function listNativeSessionIDs(): Promise<Array<{ id: string; parentID?: string }>> {
  const response = await api("/api/session?limit=200")
  if (!response.ok) return []
  const payload = (await response.json()) as { data?: unknown }
  const rows = Array.isArray(payload.data) ? (payload.data as Array<Record<string, unknown>>) : []
  return rows
    .map((row) => ({
      id: typeof row.id === "string" ? row.id : "",
      parentID: typeof row.parentID === "string" ? row.parentID : undefined,
    }))
    .filter((row) => row.id)
}

/**
 * Recovery matrix: (a) a late subscriber does not receive earlier events;
 * (b) a live event during the probe window is delivered; (c) the hub records
 * survive a server restart, and the server plugin re-registers its tools.
 */
async function runReplayProbe(): Promise<void> {
  seedRepo()
  writeConfig([{ package: probeStateEntry, options: {} }])
  rmSync(stateDir, { recursive: true, force: true })
  const probeDir = join(stateDir, "probe")

  let server: ChildProcess | undefined
  let serverOutput = () => ""
  try {
    const started = await startServerUntilReady()
    server = started.child
    serverOutput = started.output
    await forcePluginActivation()

    // Sessions published before the late subscriber attaches. A fresh
    // SUBPLUG_HARNESS_DIR keeps earlier runs out of this directory.
    const rootID = await createSession("replay root")
    const childID = await createSession("replay child", rootID)
    log(`published sessions before the late subscriber: root=${rootID} child=${childID}`)
    // Give the server tap time to fold these into the hub.
    await sleep(2500)

    const published = await listNativeSessionIDs()
    log(`server sessions: ${JSON.stringify(published)}`)
    log(`published session.created events: ${published.map((row) => row.id).join(", ")}`)
    const childRow = published.find((row) => row.id === childID)
    log(`published child parent link: ${childRow?.parentID ?? "(none)"}`)

    const { child, output } = spawnTui({
      SUBPLUG_PROBE_DIR: probeDir,
      SUBPLUG_PROBE_REPLAY: "1",
      SUBPLUG_PROBE_PLUGIN_VERSION: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string,
    }, { serverURL: base })

    // Live contrast: publish one session while the probe is subscribed. It must
    // arrive even though the earlier events do not.
    await sleep(4500)
    const liveID = await createSession("replay live")
    log(`published live session during the probe window: ${liveID}`)

    const marker = join(probeDir, "tui-state-probe.json")
    const done = await waitFor(() => existsSync(marker), 90_000, "replay probe marker")
    stop(child)
    await sleep(500)
    if (!done) {
      process.stderr.write(output().slice(-4000))
      process.stderr.write(serverOutput().slice(-4000))
      log("replay probe marker was not written")
      process.exitCode = 1
      return
    }

    const report = JSON.parse(readFileSync(marker, "utf8")) as {
      outcome?: string
      sessionCount?: number
      storeSessions?: string[]
      events?: Array<{ type?: string; sessionID?: string }>
    }
    const received = new Set((report.events ?? []).map((event) => event.sessionID).filter(Boolean) as string[])
    const replayed = published.map((row) => row.id).filter((id) => received.has(id))
    const storeHydrated = new Set(report.storeSessions ?? [])
    log(`replay probe window: ${JSON.stringify({ outcome: report.outcome, sessionCount: report.sessionCount })}`)
    log(`late subscriber store sessions: ${report.storeSessions?.join(", ") || "(none)"}`)
    log(`late subscriber events by session: ${[...received].join(", ") || "(none)"}`)
    log(
      replayed.length
        ? `REPLAY OBSERVED for pre-existing sessions: ${replayed.join(", ")}`
        : "NO REPLAY: pre-existing session events were not delivered to the late subscriber",
    )
    log(received.has(liveID) ? "LIVE DELIVERY: an event published after subscribing arrived" : "LIVE MISS: the live event did not arrive")
    log(
      published.every((row) => storeHydrated.has(row.id))
        ? "STORE HYDRATED: every pre-existing session is present in the TUI store"
        : "STORE COLD: pre-existing sessions are absent from the TUI store until backfill runs",
    )

    // Restart durability: the hub records outlive the server process.
    if (server) stop(server)
    await sleep(1000)
    const hubDir = hubRoots()[0]
    const before = hubDir ? readEvents(hubDir) : []
    const createdBefore = before.filter((event) => event.kind === "session.created").length
    log(`hub before restart: ${before.length} records, ${createdBefore} session.created`)
    server = undefined

    const restarted = await startServerUntilReady()
    server = restarted.child
    serverOutput = restarted.output
    const entry = await forcePluginActivation()
    const features = entry?.features as { server?: boolean; tui?: boolean } | undefined
    const after = hubDir ? readEvents(hubDir) : []
    const createdAfter = after.filter((event) => event.kind === "session.created").length
    log(`plugin after restart: ${JSON.stringify({ status: entry?.state, features })}`)
    log(`hub after restart: ${after.length} records, ${createdAfter} session.created`)
    log(
      features?.server && createdAfter >= createdBefore
        ? "RESTART DURABLE: hub records retained and server tools re-registered"
        : "RESTART GAP: hub records or server tools did not survive",
    )
    if (report.outcome !== "pass") process.exitCode = 1
    else log("replay/recovery probe OK")
  } finally {
    if (server) stop(server)
  }
}

async function runSpike(): Promise<void> {
  seedRepo()
  writeConfig()
  rmSync(stateDir, { recursive: true, force: true })

  let server: ChildProcess | undefined
  let output = () => ""
  const failures: string[] = []

  try {
    const started = await startServerUntilReady()
    server = started.child
    output = started.output

    // Ask the host for its plugin inventory first: that forces local plugin
    // resolution and setup, so the event tap is live before sessions exist.
    const entry = await forcePluginActivation()
    const features = entry?.features as { server?: boolean; tui?: boolean } | undefined
    const pluginState = entry?.state as { status?: string } | undefined
    log(`plugin inventory: ${JSON.stringify(entry ?? "(missing)")}`)
    if (!entry || pluginState?.status !== "active" || !features?.server) {
      failures.push("subplug plugin is not active with a server feature")
    }

    let sessionID = await createSession("subplug harness")
    log(`session created: ${sessionID}`)

    const hubReady = await waitFor(() => hubRoots().length > 0, 30_000, "hub directory")
    const hubDir = hubRoots()[0]
    if (!hubReady || !hubDir) {
      failures.push("no hub directory was created")
    } else {
      const started = await waitFor(
        () => readEvents(hubDir).some((event) => event.kind === "server.start"),
        10_000,
        "server.start",
      )
      if (!started) failures.push("server.start event missing")

      try {
        const pointer = JSON.parse(readFileSync(pointerFile, "utf8")) as { hubDir?: string }
        if (pointer.hubDir !== hubDir) {
          failures.push(`hub pointer ${pointer.hubDir ?? "(missing)"} does not match ${hubDir}`)
        } else {
          log("hub pointer matches the server hub")
        }
      } catch (error) {
        failures.push(`hub pointer unreadable: ${String(error)}`)
      }
    }

    let recorded = await waitFor(
      () => Boolean(hubDir) && readEvents(hubDir!).some((event) => event.kind === "session.created" && event.sessionID === sessionID),
      10_000,
      "session.created",
    )
    if (!recorded) {
      sessionID = await createSession("subplug harness retry")
      log(`first session raced plugin activation; retry session ${sessionID}`)
      recorded = await waitFor(
        () => Boolean(hubDir) && readEvents(hubDir!).some((event) => event.kind === "session.created" && event.sessionID === sessionID),
        15_000,
        "session.created (retry)",
      )
    }
    if (!recorded) failures.push("session.created event missing")
    if (hubDir && recorded) {
      const identity = await waitFor(
        () =>
          readEvents(hubDir).some(
            (event) =>
              event.kind === "session.identity" &&
              event.sessionID === sessionID &&
              (typeof event.refs === "object" &&
                event.refs !== null &&
                String((event.refs as Record<string, unknown>).identity ?? "").startsWith("Harness Agent@")),
          ),
        10_000,
        "session.identity",
      )
      if (!identity) failures.push("session.identity event missing for the created session")
    }

    if (hubDir) {
      const events = readEvents(hubDir)
      log(`hub events: ${events.length}`)
      for (const event of events.slice(-8)) {
        log(`  ${JSON.stringify(event)}`)
      }
      const nodes = foldSessions(readEventRecords(hubDir))
      log(`folded sessions: ${nodes.length}`)
      for (const node of nodes.slice(-5)) {
        log(`  [${node.kind}] ${node.sessionID} status=${node.status} identity=${node.identity ?? "-"}`)
      }
    }

    const strings = collectStrings(await (await api("/api/info")).json())
    log(`api info fields: ${strings.length}`)
  } catch (error) {
    failures.push(String(error))
    process.stderr.write(output().slice(-4000))
  } finally {
    if (server) stop(server)
    await sleep(500)
    if (!keep) rmSync(harnessDir, { recursive: true, force: true })
  }

  if (failures.length) {
    log(`FAILED: ${failures.join("; ")}`)
    process.exit(1)
  }
  log("spike OK: server plugin loaded, live tap + identity verified, hub pointer matches")
}

async function main(): Promise<void> {
  if ((existingServerMode || probeExecute || probeTask || probeReplay) && !probeTuiState) {
    throw new Error("--existing-server, --probe-execute, --probe-task and --probe-replay require --probe-tui-state")
  }
  if (existingServerMode && attachMode) {
    throw new Error("choose either --existing-server or --attach")
  }
  if (inspectMode) {
    runInspect()
    return
  }
  if (pokeRisk) {
    runPokeRisk()
    return
  }
  if (demoMode) {
    await runDemo()
    return
  }
  if (tuiOnly) {
    await runTuiCheck()
    return
  }
  if (probeTuiState) {
    if (probeReplay) await runReplayProbe()
    else await runTuiStateProbe()
    return
  }
  await runSpike()
}

await main()
