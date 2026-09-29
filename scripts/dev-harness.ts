import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readEventRecords, EventLog } from "../src/hub/append.ts"
import { foldSessions } from "../src/hub/fold.ts"
import { joinClaimsToSessions, readMonitorState } from "../src/hub/monitor.ts"
import type { EventRecord } from "../src/shared/types.ts"
import { resolveOpencodeBin } from "./opencode-bin.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const harnessDir = join(root, ".harness")
const repoDir = join(harnessDir, "repo")
const configDir = join(harnessDir, "config")
const stateDir = join(harnessDir, "state")
const port = process.env.SUBPLUG_HARNESS_PORT
  ? Number(process.env.SUBPLUG_HARNESS_PORT)
  : 4100 + Math.floor(Math.random() * 900)
const base = `http://127.0.0.1:${port}`
const keep = process.argv.includes("--keep")
const tuiOnly = process.argv.includes("--tui")
const demoMode = process.argv.includes("--demo")
const pokeRisk = process.argv.includes("--poke-risk")
const inspectMode = process.argv.includes("--inspect")
const probeComms = process.argv.includes("--probe-comms")
const probeTuiState = process.argv.includes("--probe-tui-state")
const probeInject = process.argv.includes("--probe-inject")
const verbose = process.argv.includes("--verbose")

const serverEntry = join(root, "src", "server", "index.ts").replace(/\\/g, "/")
const tuiEntry = join(root, "src", "tui", "index.tsx").replace(/\\/g, "/")
const harnessIdentity = `Harness Agent@${hostname()}`

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

function log(message: string): void {
  process.stdout.write(`[harness] ${message}\n`)
}

function seedRepo(): void {
  rmSync(repoDir, { recursive: true, force: true })
  mkdirSync(join(repoDir, "coordination", "claims"), { recursive: true })
  mkdirSync(join(repoDir, "src"), { recursive: true })
  mkdirSync(join(repoDir, "plans", "workstreams"), { recursive: true })
  writeFileSync(join(repoDir, "src", "app.py"), "print('hello')\n")
  writeFileSync(join(repoDir, "README.md"), "# harness repo\n")
  writeFileSync(
    join(repoDir, "plans", ".plant-lock.json"),
    JSON.stringify({ version: 3, source_revision: "test", files: { "PROTOCOL.md": "x" } }, null, 2),
  )
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

function writeConfig(extraTuiPlugins: Array<[string, Record<string, unknown>]> = []): void {
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
    plugin: [[serverEntry, { coord: { injectIdentity: true }, storageDir: stateDir }]],
  }
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify(config, null, 2))
  const tuiConfig = {
    $schema: "https://opencode.ai/tui.json",
    plugin: [[tuiEntry, { enabled: true, storageDir: stateDir }], ...extraTuiPlugins],
  }
  writeFileSync(join(configDir, "tui.json"), JSON.stringify(tuiConfig, null, 2))
}

async function waitForServer(timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let lastError = "no response"
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/path`, { signal: AbortSignal.timeout(2500) })
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
    .filter((dir) => existsSync(dir))
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

function refString(event: Record<string, unknown>, key: string): string | undefined {
  const refs = event.refs
  if (!refs || typeof refs !== "object") return undefined
  const value = (refs as Record<string, unknown>)[key]
  return typeof value === "string" ? value : undefined
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

async function startServerUntilReady(attempts = 3): Promise<{ child: ChildProcess; output: () => string }> {
  let last: { child: ChildProcess; output: () => string } | undefined
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    killStaleServer()
    last = spawnServer("INFO")
    try {
      const paths = await waitForServer(45_000)
      log(`server ready (attempt ${attempt}): ${JSON.stringify(paths)}`)
      return last
    } catch (error) {
      log(`server attempt ${attempt} failed: ${String(error)}`)
      stop(last.child)
      await sleep(1500)
    }
  }
  throw new Error("server did not become ready after retries")
}

function harnessEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    XDG_STATE_HOME: join(harnessDir, "xdg", "state"),
    XDG_DATA_HOME: join(harnessDir, "xdg", "data"),
    XDG_CACHE_HOME: join(harnessDir, "xdg", "cache"),
    OPENCODE_CONFIG_DIR: configDir,
    ...extra,
  }
}

function spawnServer(logLevel: string): { child: ChildProcess; output: () => string } {
  const bin = resolveOpencodeBin()
  const child = spawn(bin, ["serve", "--port", String(port), "--print-logs", "--log-level", logLevel], {
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

function launchInstructions(): void {
  log("launch the TUI:")
  log(`  PowerShell: $env:OPENCODE_CONFIG_DIR="${configDir}"; opencode "${repoDir}"`)
  log(`  POSIX:      export OPENCODE_CONFIG_DIR="${configDir}"; opencode "${repoDir}"`)
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

  const { child, output } = spawnServer("ERROR")
  try {
    await waitForServer(120_000)
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
  for (const dir of dirs) {
    const state = readMonitorState(dir, repoDir)
    log(`hub ${dir}`)
    log(`sessions: ${state.sessions.length}`)
    for (const session of state.sessions) {
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
}

async function runTuiCheck(): Promise<void> {
  seedRepo()
  writeConfig()
  rmSync(stateDir, { recursive: true, force: true })
  const bin = resolveOpencodeBin()
  const child = spawn(bin, [repoDir, "--print-logs", "--log-level", "INFO"], {
    cwd: repoDir,
    env: harnessEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  })
  let output = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })
  const marker = join(stateDir, "subplug", "tui-plugin-loaded.json")
  const loaded = await waitFor(() => existsSync(marker), 90_000, "tui plugin marker")
  stop(child)
  await sleep(500)
  if (loaded) {
    log(`TUI plugin loaded: ${readFileSync(marker, "utf8").trim()}`)
    log(`slot: sidebar "Agents" (order 650); route/command: /subplug`)
    log("TUI check OK")
    return
  }
  process.stderr.write(output.slice(-4000))
  log("TUI marker was not written; run interactively: ")
  log(`  set OPENCODE_CONFIG_DIR=${configDir}`)
  log(`  opencode ${repoDir}`)
  process.exit(1)
}

type ProbeSession = { id?: string }

async function createProbeSession(body: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${base}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`POST /session -> HTTP ${response.status}: ${await response.text()}`)
  const session = (await response.json()) as ProbeSession
  if (!session.id) throw new Error("POST /session returned no id")
  return session.id
}

async function probeJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`)
  return response.json()
}

async function runProbeComms(): Promise<void> {
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
    const rootID = await createProbeSession({ title: "probe root" })
    const childID = await createProbeSession({ parentID: rootID, title: "probe child" })
    log(`probe sessions: root=${rootID} child=${childID}`)

    const startedAt = Date.now()
    const shellPromise = fetch(`${base}/session/${childID}/shell`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "build", command: "sleep 6; echo PROBE_SHELL_DONE" }),
      signal: AbortSignal.timeout(60_000),
    }).then(async (response) => ({ status: response.status, text: await response.text() }))
    await sleep(1500)

    try {
      const statuses = (await probeJson(`${base}/session/status`)) as Record<string, { type?: string }>
      log(`child status mid-shell: ${statuses[childID]?.type ?? "(missing)"}`)
    } catch (error) {
      log(`status probe failed: ${String(error)}`)
    }

    const v1At = Date.now() - startedAt
    const v1Response = await fetch(`${base}/session/${childID}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ noReply: true, parts: [{ type: "text", text: "PROBE_V1_NO_REPLY" }] }),
      signal: AbortSignal.timeout(30_000),
    })
    const v1Text = await v1Response.text()
    log(`v1 noReply at +${v1At}ms: HTTP ${v1Response.status} ${v1Text.slice(0, 200)}`)
    if (!v1Response.ok) failures.push(`v1 noReply failed: HTTP ${v1Response.status}`)

    let v2Report = "not-run"
    try {
      const v2Response = await fetch(`${base}/api/session/${childID}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: { text: "PROBE_V2_QUEUE" }, delivery: "queue" }),
        signal: AbortSignal.timeout(30_000),
      })
      v2Report = `HTTP ${v2Response.status} ${(await v2Response.text()).slice(0, 220)}`
    } catch (error) {
      v2Report = `error ${String(error)}`
    }
    log(`v2 queue prompt on v1 session at +${Date.now() - startedAt}ms: ${v2Report}`)

    const shellResult = await shellPromise
    log(`shell done at +${Date.now() - startedAt}ms: HTTP ${shellResult.status}`)
    if (!shellResult.text.includes("PROBE_SHELL_DONE")) {
      failures.push("shell output did not contain PROBE_SHELL_DONE")
    }

    await sleep(1000)
    const messages = (await probeJson(`${base}/session/${childID}/message`)) as Array<{
      info?: { role?: string }
      parts?: Array<{ type?: string; text?: string }>
    }>
    const texts = messages.flatMap((row) => row.parts ?? []).map((part) => part.text ?? "")
    log(`child messages: ${messages.length} roles=[${messages.map((row) => row.info?.role ?? "?").join(",")}]`)
    log(`v1 message present: ${texts.some((text) => text.includes("PROBE_V1_NO_REPLY"))}`)
    log(`v2 message present: ${texts.some((text) => text.includes("PROBE_V2_QUEUE"))}`)

    try {
      const contextResponse = await fetch(`${base}/api/session/${childID}/context`, {
        signal: AbortSignal.timeout(15_000),
      })
      log(`v2 context read: HTTP ${contextResponse.status} ${(await contextResponse.text()).slice(0, 220)}`)
    } catch (error) {
      log(`v2 context read failed: ${String(error)}`)
    }
  } catch (error) {
    failures.push(String(error))
    process.stderr.write(output().slice(-4000))
  } finally {
    if (server) stop(server)
    await sleep(500)
    if (!keep) rmSync(harnessDir, { recursive: true, force: true })
  }

  if (failures.length) {
    log(`PROBE FAILED: ${failures.join("; ")}`)
    process.exit(1)
  }
  log("comms probe complete")
}

async function runProbeInject(): Promise<void> {
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
    const rootID = await createProbeSession({ title: "inject root" })
    const childID = await createProbeSession({ parentID: rootID, title: "inject child" })
    log(`probe sessions: root=${rootID} child=${childID}`)

    stop(server)
    await sleep(1000)
    server = undefined

    const dirs = hubRoots()
    const hubDir = dirs[0]
    if (!hubDir) throw new Error("no hub directory was created")
    const eventLog = new EventLog(hubDir, `probe-inject-${Math.random().toString(16).slice(2, 8)}`)
    eventLog.append({
      ts: Date.now(),
      serverID: "probe-inject",
      sessionID: childID,
      kind: "comms.sent",
      summary: "PROBE_INJECT_NOTICE",
      refs: { msgID: "msg_probe_inject", to: childID, from: "probe@harness", kind: "message", delivery: "queue" },
    })

    const restarted = await startServerUntilReady()
    server = restarted.child
    output = restarted.output

    void fetch(`${base}/session/${childID}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "build", parts: [{ type: "text", text: "PROBE_INJECT_TRIGGER" }] }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined)

    let injected = false
    let injectedText = ""
    let partIds: string[] = []
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !injected) {
      try {
        const messages = (await probeJson(`${base}/session/${childID}/message`)) as Array<{
          info?: { role?: string }
          parts?: Array<{ id?: string; type?: string; text?: string; synthetic?: boolean }>
        }>
        const user = messages.find(
          (row) =>
            row.info?.role === "user" && (row.parts ?? []).some((part) => part.text === "PROBE_INJECT_TRIGGER"),
        )
        if (user) {
          partIds = (user.parts ?? []).map((part) => part.id ?? "?")
          const synthetic = (user.parts ?? []).find(
            (part) => part.synthetic && typeof part.text === "string" && part.text.includes("PROBE_INJECT_NOTICE"),
          )
          if (synthetic) {
            injected = true
            injectedText = synthetic.text ?? ""
          }
        }
      } catch {
        // keep polling while the prompt is in flight
      }
      if (!injected) await sleep(500)
    }

    log(`synthetic inbox part persisted: ${injected}`)
    log(`user message part ids: ${JSON.stringify(partIds)}`)
    if (injected) log(`injected text: ${injectedText.split("\n")[0]}`)
    if (!injected) failures.push("synthetic inbox part was not persisted on the user message")

    const delivered = await waitFor(
      () => readEvents(hubDir).some((event) => event.kind === "comms.delivered"),
      10_000,
      "comms.delivered",
    )
    log(`comms.delivered recorded: ${delivered}`)
    if (!delivered) failures.push("comms.delivered event missing")
  } catch (error) {
    failures.push(String(error))
    process.stderr.write(output().slice(-4000))
  } finally {
    if (server) stop(server)
    await sleep(500)
    if (!keep) rmSync(harnessDir, { recursive: true, force: true })
  }

  if (failures.length) {
    log(`PROBE FAILED: ${failures.join("; ")}`)
    process.exit(1)
  }
  log("inject probe complete")
}

async function runTuiStateProbe(): Promise<void> {
  seedRepo()
  const probeEntry = join(root, "scripts", "probe-tui-state.ts").replace(/\\/g, "/")
  writeConfig([[probeEntry, {}]])
  rmSync(stateDir, { recursive: true, force: true })

  const probeDir = join(stateDir, "probe")
  const bin = resolveOpencodeBin()
  const child = spawn(bin, [repoDir, "--print-logs", "--log-level", "INFO"], {
    cwd: repoDir,
    env: harnessEnv({ SUBPLUG_PROBE_DIR: probeDir }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  })
  let output = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })

  const marker = join(probeDir, "tui-state-probe.json")
  const done = await waitFor(() => existsSync(marker), 90_000, "tui state probe marker")
  stop(child)
  await sleep(500)

  if (done) {
    log(`TUI state probe: ${readFileSync(marker, "utf8").trim()}`)
    if (!keep) rmSync(harnessDir, { recursive: true, force: true })
    log("TUI state probe OK")
    return
  }

  process.stderr.write(output.slice(-4000))
  log("TUI state probe marker was not written")
  process.exit(1)
}

async function runSpike(): Promise<void> {
  seedRepo()
  writeConfig()
  rmSync(stateDir, { recursive: true, force: true })

  const bin = resolveOpencodeBin()
  log(`opencode: ${bin}`)
  log(`repo: ${repoDir}`)
  log(`config: ${configDir}`)
  log(`state: ${stateDir}`)

  let server: ChildProcess | undefined
  let output = () => ""
  const failures: string[] = []

  try {
    const started = await startServerUntilReady()
    server = started.child
    output = started.output
    const paths = await probeJson(`${base}/path`)
    log(`server ready: ${JSON.stringify(paths)}`)

    const dirs = hubRoots()
    if (!dirs.length) failures.push("no hub directory was created")
    const hubDir = dirs[0]
    if (hubDir) {
      const started = await waitFor(
        () => readEvents(hubDir).some((event) => event.kind === "server.start"),
        10_000,
        "server.start",
      )
      if (!started) failures.push("server.start event missing")
    }

    const createResponse = await fetch(`${base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "subplug harness" }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!createResponse.ok) {
      failures.push(`POST /session failed: HTTP ${createResponse.status}`)
    } else {
      const session = (await createResponse.json()) as { id?: string }
      log(`session created: ${session.id ?? "(unknown id)"}`)
      if (hubDir && session.id) {
        const recorded = await waitFor(
          () => readEvents(hubDir).some((event) => event.kind === "session.created"),
          10_000,
          "session.created",
        )
        if (!recorded) failures.push("session.created event missing")
      }
      if (session.id) {
        const shellResponse = await fetch(`${base}/session/${session.id}/shell`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "build", command: 'node -p "process.env.COORD_AGENT_ID"' }),
          signal: AbortSignal.timeout(30_000),
        })
        const shellBody = (await shellResponse.json().catch(() => undefined)) as unknown
        const strings = collectStrings(shellBody)
        const probe = strings.find((value) => value.includes("Harness Agent@"))
        const expectedRootSuffix = `/${session.id}`
        log(`root identity probe: HTTP ${shellResponse.status} identity=${probe ?? "(not found)"}`)
        if (!shellResponse.ok) {
          failures.push(`identity probe failed: HTTP ${shellResponse.status}`)
        } else if (!probe) {
          failures.push("shell.env identity probe did not expose COORD_AGENT_ID=Harness Agent@<host>")
        } else if (!probe.trim().endsWith(expectedRootSuffix)) {
          failures.push(`root identity did not end with ${expectedRootSuffix}, got ${probe}`)
        }
        if (hubDir) {
          const recordedIdentity = await waitFor(
            () => readEvents(hubDir).some((event) => event.kind === "session.identity"),
            10_000,
            "session.identity",
          )
          if (!recordedIdentity) failures.push("session.identity event missing after shell probe")
        }
      }

      const childResponse = await fetch(`${base}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentID: session.id, title: "subplug child" }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!childResponse.ok) {
        failures.push(`child POST /session failed: HTTP ${childResponse.status}`)
      } else {
        const childSession = (await childResponse.json()) as { id?: string }
        log(`child session created: ${childSession.id ?? "(unknown id)"}`)
        if (!childSession.id) {
          failures.push("child session id missing")
        } else {
          if (hubDir) {
            const recorded = await waitFor(
              () =>
                readEvents(hubDir).some(
                  (event) => event.kind === "session.created" && event.sessionID === childSession.id,
                ),
              10_000,
              "child session.created",
            )
            if (!recorded) failures.push("child session.created missing")
            await sleep(300)
          }
          const expectedSuffix = `/${childSession.id}`
          const childShell = await fetch(`${base}/session/${childSession.id}/shell`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "build", command: 'node -p "process.env.COORD_AGENT_ID"' }),
            signal: AbortSignal.timeout(30_000),
          })
          const childBody = (await childShell.json().catch(() => undefined)) as unknown
          const childStrings = collectStrings(childBody)
          const childProbe = childStrings.find(
            (value) => value.includes("Harness Agent@") && value.includes(expectedSuffix),
          )
          log(`child identity probe: HTTP ${childShell.status} identity=${childProbe ?? "(not found)"}`)
          if (!childShell.ok) {
            failures.push(`child identity probe failed: HTTP ${childShell.status}`)
          } else if (!childProbe) {
            failures.push(`child identity did not include suffix ${expectedSuffix}`)
          }
          if (hubDir) {
            const childIdentity = await waitFor(
              () =>
                readEvents(hubDir).some(
                  (event) =>
                    event.kind === "session.identity" &&
                    event.sessionID === childSession.id &&
                    (refString(event, "identity") ?? "").endsWith(expectedSuffix),
                ),
              10_000,
              "child session.identity",
            )
            if (!childIdentity) failures.push("child session.identity missing or lacks the unique suffix")

            const nodes = foldSessions(readEventRecords(hubDir))
            const childNode = nodes.find((node) => node.sessionID === childSession.id)
            if (childNode?.kind !== "subagent") failures.push("child session did not fold as a subagent")
            if (childNode?.parentID !== session.id) failures.push("child session parentID mismatch")
          }
        }
      }
    }

    try {
      const toolResponse = await fetch(`${base}/experimental/tool/ids`, { signal: AbortSignal.timeout(15_000) })
      if (toolResponse.ok) {
        const ids = (await toolResponse.json()) as unknown
        const found = JSON.stringify(ids).includes("swarm_status")
        log(`tool ids include swarm_status: ${found}`)
        if (!found) failures.push("swarm_status tool was not registered")
      } else {
        failures.push(`tool id listing failed: HTTP ${toolResponse.status}`)
      }
    } catch (error) {
      failures.push(`tool id listing errored: ${String(error)}`)
    }

    if (hubDir) {
      const events = readEvents(hubDir)
      log(`hub events: ${events.length}`)
      for (const event of events.slice(-12)) {
        log(`  ${JSON.stringify(event)}`)
      }
    }
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
  log("spike OK: server plugin loaded, session tree + unique subagent identity verified, swarm_status registered")
}

async function main(): Promise<void> {
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
  if (probeComms) {
    await runProbeComms()
    return
  }
  if (probeTuiState) {
    await runTuiStateProbe()
    return
  }
  if (probeInject) {
    await runProbeInject()
    return
  }
  await runSpike()
}

await main()
