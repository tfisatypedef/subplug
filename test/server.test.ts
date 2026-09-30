import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import serverModule, { recordFor, resolveOptions, server, setupServer } from "../src/server/index.ts"
import { EventLog, readEventRecords } from "../src/hub/append.ts"
import { foldSessions } from "../src/hub/fold.ts"
import { fallbackStateDir, hubRoot, readHubPointer } from "../src/hub/paths.ts"
import type { EventRecord } from "../src/shared/types.ts"
import { makeV2Context, type V2Fake } from "./v2-context.ts"

const PROJECT_ID = "v2-test-project"
const sessionsRoot = join(tmpdir(), "subplug-server-tests")
mkdirSync(sessionsRoot, { recursive: true })
process.env.XDG_STATE_HOME = join(sessionsRoot, "xdg")

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()?.()
    } catch {
      // ignore cleanup failures
    }
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(sessionsRoot, prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? result.stdout}`)
  }
}

function identity(): string {
  return `Harness Agent@${hostname()}`
}

function seedRepo(claimFiles: string[], sessionID?: string, withCoordination = true): string {
  const repo = tempDir("repo-")
  if (withCoordination) mkdirSync(join(repo, "coordination", "claims"), { recursive: true })
  git(repo, ["init", "-q"])
  git(repo, ["config", "user.name", "Harness Agent"])
  git(repo, ["config", "user.email", "harness@testhost"])
  writeFileSync(join(repo, "README.md"), "# repo\n")
  if (withCoordination) {
    const claim = {
      event_id: "server-test-claim",
      kind: "claim",
      agent: sessionID ? `${identity()}/${sessionID}` : identity(),
      issued: "2026-09-27T10:00:00Z",
      expires: "2099-01-01T00:00:00Z",
      claim_id: "claim-server-test",
      scopes: { patterns: [], files: claimFiles, docs: [], evidence: [], baton: null },
    }
    writeFileSync(join(repo, "coordination", "claims", "harness.jsonl"), `${JSON.stringify(claim)}\n`)
    git(repo, ["add", "README.md", "coordination"])
    git(repo, ["commit", "-q", "-m", "seed"])
  }
  return repo
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

function hubEvents(stateDir: string, group = PROJECT_ID): EventRecord[] {
  return readEventRecords(hubRoot(stateDir, group))
}

async function startPlugin(
  repo: string,
  stateDir: string,
  options: { hubGroup?: string } = {},
): Promise<V2Fake> {
  const pluginOptions: Record<string, unknown> = { storageDir: stateDir }
  if (options.hubGroup) pluginOptions.hubGroup = options.hubGroup
  const fake = makeV2Context(pluginOptions, repo, PROJECT_ID)
  const stop = await setupServer(fake.ctx)
  cleanups.push(stop)
  return fake
}

function stage(repo: string): void {
  writeFileSync(join(repo, "covered.txt"), "covered\n")
  writeFileSync(join(repo, "uncovered.txt"), "uncovered\n")
  git(repo, ["add", "covered.txt", "uncovered.txt"])
}

describe("v2 server options", () => {
  test("resolves defaults and nested overrides", () => {
    const defaults = resolveOptions(undefined)
    expect(defaults.injectComms).toBe(true)
    expect(defaults.maxAgeMs).toBe(24 * 60 * 60 * 1000)
    expect(defaults.web).toEqual({ enabled: false, port: 7690, token: undefined })

    const override = resolveOptions({
      coord: { hubGroup: "shared", storageDir: "/tmp/hub", retentionBytes: 2048, maxAgeMs: 60_000 },
      web: { enabled: true, port: 1234, token: "secret" },
    })
    expect(override).toEqual({
      injectComms: true,
      hubGroup: "shared",
      storageDir: "/tmp/hub",
      retentionBytes: 2048,
      maxAgeMs: 60_000,
      web: { enabled: true, port: 1234, token: "secret" },
    })

    expect(resolveOptions({ injectComms: false }).injectComms).toBe(false)
    expect(resolveOptions({ comms: { inject: false } }).injectComms).toBe(false)
  })
})

describe("v2 event mapping", () => {
  test("maps session lifecycle events onto hub record kinds", () => {
    expect(
      recordFor(
        "srv",
        {
          type: "session.created",
          data: {
            sessionID: "ses_a",
            parentID: "ses_p",
            location: { directory: "/repo" },
            title: "Title",
            agent: "build",
            model: { id: "model-1", providerID: "p" },
          },
        },
        42,
      ),
    ).toEqual({
      ts: 42,
      serverID: "srv",
      sessionID: "ses_a",
      parentID: "ses_p",
      kind: "session.created",
      refs: {
        title: "Title",
        directory: "/repo",
        parentID: "ses_p",
        agent: "build",
        model: "model-1",
      },
    })

    expect(recordFor("srv", { type: "session.renamed", data: { sessionID: "ses_a", title: "renamed" } }, 1)).toMatchObject({
      kind: "session.updated",
      refs: { title: "renamed" },
    })
    expect(recordFor("srv", { type: "session.agent.selected", data: { sessionID: "ses_a", agent: "plan" } }, 1)).toMatchObject({
      kind: "session.agent",
      refs: { agent: "plan" },
    })
    expect(
      recordFor("srv", { type: "session.model.selected", data: { sessionID: "ses_a", model: { id: "m2" } } }, 1),
    ).toMatchObject({ kind: "session.model", refs: { model: "m2" } })
    expect(recordFor("srv", { type: "session.usage.updated", data: { sessionID: "ses_a", cost: 2.5 } }, 1)).toMatchObject({
      kind: "session.updated",
      refs: { cost: 2.5 },
    })
    expect(recordFor("srv", { type: "session.deleted", data: { sessionID: "ses_a" } }, 1)).toMatchObject({
      kind: "session.deleted",
    })
  })

  test("maps execution events onto status records", () => {
    expect(recordFor("srv", { type: "session.execution.started", data: { sessionID: "ses_a" } }, 1)).toMatchObject({
      kind: "session.status",
      refs: { status: "busy" },
    })
    expect(recordFor("srv", { type: "session.execution.succeeded", data: { sessionID: "ses_a" } }, 1)).toMatchObject({
      kind: "session.idle",
    })
    expect(
      recordFor("srv", { type: "session.execution.interrupted", data: { sessionID: "ses_a", reason: "user" } }, 1),
    ).toMatchObject({ kind: "session.idle" })
    expect(
      recordFor("srv", { type: "session.execution.failed", data: { sessionID: "ses_a", error: { message: "boom" } } }, 1),
    ).toMatchObject({ kind: "session.error", summary: "boom" })
    expect(
      recordFor("srv", { type: "session.step.failed", data: { sessionID: "ses_a", error: { name: "ProviderError" } } }, 1),
    ).toMatchObject({ kind: "session.error", summary: "ProviderError" })
    expect(
      recordFor("srv", { type: "session.retry.scheduled", data: { sessionID: "ses_a", attempt: 2 } }, 1),
    ).toMatchObject({ kind: "session.status", refs: { status: "retry" } })
    expect(
      recordFor("srv", { type: "session.status", data: { sessionID: "ses_a", status: { type: "busy" } } }, 1),
    ).toMatchObject({ kind: "session.status", refs: { status: "busy" } })
    expect(
      recordFor("srv", { type: "session.status", data: { sessionID: "ses_a", status: { type: "idle" } } }, 1),
    ).toMatchObject({ kind: "session.idle" })
    expect(recordFor("srv", { type: "session.idle", data: { sessionID: "ses_a" } }, 1)).toMatchObject({
      kind: "session.idle",
    })
  })

  test("ignores unrelated and malformed events", () => {
    expect(recordFor("srv", { type: "session.text.delta", data: { sessionID: "ses_a", delta: "x" } }, 1)).toBeUndefined()
    expect(recordFor("srv", { type: "session.created", data: { title: "no id" } }, 1)).toBeUndefined()
    expect(recordFor("srv", { type: "session.usage.updated", data: { sessionID: "ses_a" } }, 1)).toBeUndefined()
    expect(
      recordFor("srv", { type: "session.status", data: { sessionID: "ses_a", status: { type: "weird" } } }, 1),
    ).toBeUndefined()
  })
})

describe("v2 server shell", () => {
  test("exposes the plugin id and writes a server.start marker", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    const events = hubEvents(stateDir)
    expect(server.id).toBe("subplug")
    expect(serverModule.id).toBe("subplug")
    expect(events.some((record) => record.kind === "server.start" && record.refs?.directory === repo)).toBe(true)
    expect(readHubPointer()?.hubDir).toBe(hubRoot(stateDir, PROJECT_ID))
    expect(fake.tools.has("swarm_status")).toBe(true)
    expect(fake.tools.has("swarm_send")).toBe(true)
  })

  test("folds live events into the hub and stops after cleanup", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)

    fake.stream.push("session.created", { sessionID: "ses_root", location: { directory: repo }, title: "root" })
    fake.stream.push("session.created", { sessionID: "ses_child", parentID: "ses_root", location: { directory: repo } })
    fake.stream.push("session.execution.started", { sessionID: "ses_child" })

    expect(await waitFor(() => hubEvents(stateDir).some((record) => record.sessionID === "ses_child"))).toBe(true)
    const nodes = foldSessions(hubEvents(stateDir))
    expect(nodes.find((node) => node.sessionID === "ses_root")).toMatchObject({ kind: "root", title: "root", status: "idle" })
    expect(nodes.find((node) => node.sessionID === "ses_child")).toMatchObject({
      kind: "subagent",
      parentID: "ses_root",
      status: "busy",
    })

    fake.stream.push("session.execution.succeeded", { sessionID: "ses_child" })
    expect(
      await waitFor(
        () => foldSessions(hubEvents(stateDir)).find((node) => node.sessionID === "ses_child")?.status === "idle",
      ),
    ).toBe(true)

    cleanups.pop()?.()
    await new Promise((resolve) => setTimeout(resolve, 50))
    fake.stream.push("session.created", { sessionID: "ses_after_stop", location: { directory: repo } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(hubEvents(stateDir).some((record) => record.sessionID === "ses_after_stop")).toBe(false)
  })

  test("uses the hubGroup override for the hub directory", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    await startPlugin(repo, stateDir, { hubGroup: "shared-swarm" })
    expect(hubEvents(stateDir, "shared-swarm").length).toBeGreaterThan(0)
    expect(hubEvents(stateDir).length).toBe(0)
  })

  test("serves web transcripts through the session context", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    const port = 4300 + Math.floor(Math.random() * 500)
    const fake = makeV2Context(
      { storageDir: stateDir, web: { enabled: true, port } },
      repo,
      PROJECT_ID,
    )
    const stop = await setupServer(fake.ctx)
    cleanups.push(stop)
    fake.stream.push("session.created", { sessionID: "ses_web0000000001", location: { directory: repo }, title: "web" })
    fake.contexts.set("ses_web0000000001", [
      { id: "msg_web_user00001", type: "user", text: "hello from the web" },
    ])
    expect(await waitFor(() => hubEvents(stateDir).some((record) => record.sessionID === "ses_web0000000001"))).toBe(true)

    let response: Response | undefined
    for (let attempt = 0; attempt < 40 && !response; attempt += 1) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/session/ses_web0000000001`)
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    expect(response?.status).toBe(200)
    const body = (await response!.json()) as { messages: Array<{ role: string; text: string }> }
    expect(body.messages[0]).toMatchObject({ role: "user", text: "hello from the web" })

    const missing = await fetch(`http://127.0.0.1:${port}/api/session/ses_missing0000001`)
    expect(missing.status).toBe(404)
  })

  test("falls back to the XDG state dir without a storageDir option", async () => {
    const previous = process.env.XDG_STATE_HOME
    const xdg = tempDir("xdg-")
    process.env.XDG_STATE_HOME = xdg
    try {
      const repo = seedRepo([], undefined, false)
      const fake = makeV2Context({}, repo, PROJECT_ID)
      const stop = await setupServer(fake.ctx)
      cleanups.push(stop)
      expect(readEventRecords(hubRoot(fallbackStateDir(), PROJECT_ID)).length).toBeGreaterThan(0)
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
    }
  })
})

describe("v2 server identity", () => {
  test("records session identity inside coordination-enabled repositories", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    fake.stream.push("session.created", { sessionID: "ses_identity", location: { directory: repo } })
    expect(await waitFor(() => hubEvents(stateDir).some((record) => record.kind === "session.identity"))).toBe(true)
    const record = hubEvents(stateDir).find((event) => event.kind === "session.identity")
    expect(record?.sessionID).toBe("ses_identity")
    expect(record?.refs?.identity).toBe(`${identity()}/ses_identity`)
  })

  test("skips identity outside coordination-enabled repositories", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    fake.stream.push("session.created", { sessionID: "ses_plain", location: { directory: repo } })
    expect(await waitFor(() => hubEvents(stateDir).some((record) => record.sessionID === "ses_plain"))).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(hubEvents(stateDir).some((record) => record.kind === "session.identity")).toBe(false)
  })

  test("prefixes bash commands with the per-session identity", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    const input: Record<string, unknown> = { command: "git status" }
    await fake.runToolBefore({ tool: "bash", sessionID: "ses_prefix0000001", input })

    expect(input.command).toBe(`export COORD_AGENT_ID='${identity()}/ses_prefix0000001'; git status`)
    const record = hubEvents(stateDir).find((event) => event.kind === "session.identity")
    expect(record?.sessionID).toBe("ses_prefix0000001")
    expect(record?.refs?.identity).toBe(`${identity()}/ses_prefix0000001`)
  })

  test("leaves bash commands untouched outside coordination", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    const input: Record<string, unknown> = { command: "git status" }
    await fake.runToolBefore({ tool: "bash", sessionID: "ses_plain0000001", input })
    expect(input.command).toBe("git status")
  })
})

describe("v2 server coverage risk", () => {
  test("records command.risk for a commit with uncovered staged paths", async () => {
    const repo = seedRepo(["covered.txt"], "ses_roottest00001")
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    stage(repo)

    await fake.runToolBefore({ tool: "bash", sessionID: "ses_roottest00001", input: { command: 'git commit -m "test"' } })

    const risks = hubEvents(stateDir).filter((event) => event.kind === "command.risk")
    expect(risks.length).toBe(1)
    expect(risks[0]?.refs?.category).toBe("git-commit")
    expect(risks[0]?.refs?.uncovered).toBe(1)
    expect(risks[0]?.summary).toContain("uncovered")
  })

  test("records no risk when every staged path is covered", async () => {
    const repo = seedRepo(["covered.txt", "uncovered.txt"], "ses_roottest00002")
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    stage(repo)

    await fake.runToolBefore({ tool: "bash", sessionID: "ses_roottest00002", input: { command: 'git commit -m "test"' } })

    expect(hubEvents(stateDir).filter((event) => event.kind === "command.risk")).toEqual([])
  })

  test("does not run coverage for non-risky commands", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    stage(repo)

    await fake.runToolBefore({ tool: "bash", sessionID: "ses_roottest00003", input: { command: "ls -la" } })

    expect(hubEvents(stateDir).filter((event) => event.kind === "command.risk")).toEqual([])
    expect(hubEvents(stateDir).some((event) => event.kind === "command")).toBe(true)
  })

  test("records coverage risk and prefixes the command in a coordination repo", async () => {
    const repo = seedRepo(["covered.txt"], "ses_roottest00004")
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    stage(repo)

    const input: Record<string, unknown> = { command: 'git commit -m "test"' }
    await fake.runToolBefore({ tool: "bash", sessionID: "ses_roottest00004", input })

    expect(input.command).toBe(`export COORD_AGENT_ID='${identity()}/ses_roottest00004'; git commit -m "test"`)
    const risks = hubEvents(stateDir).filter((event) => event.kind === "command.risk")
    expect(risks.length).toBe(1)
    expect(risks[0]?.refs?.uncovered).toBe(1)
  })
})

describe("v2 server swarm_status detail", () => {
  test("returns session detail and gates messages behind the messages arg", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    fake.stream.push("session.created", {
      sessionID: "ses_detail0000001",
      location: { directory: repo },
      title: "detail root",
    })
    fake.contexts.set("ses_detail0000001", [
      { id: "msg_user00000001", time: { created: 1 }, type: "user", text: "please review" },
      {
        id: "msg_assistant0001",
        time: { created: 2 },
        type: "assistant",
        agent: "build",
        model: { id: "test/model", providerID: "test" },
        content: [
          { type: "text", text: "working on it" },
          { type: "tool", id: "call_1", name: "bash", state: { status: "completed", input: {}, content: [] }, time: { created: 3 } },
        ],
      },
    ])
    expect(await waitFor(() => hubEvents(stateDir).some((event) => event.sessionID === "ses_detail0000001"))).toBe(true)

    const tool = fake.tools.get("swarm_status")!
    const withoutMessages = await tool.execute({ session: "ses_detail0000001" }, {})
    expect(withoutMessages.content).toContain("detail root")
    expect(withoutMessages.content).not.toContain("working on it")

    const withMessages = await tool.execute({ session: "ses_detail0000001", messages: 5 }, {})
    expect(withMessages.content).toContain("working on it")
    expect(withMessages.content).toContain("[tool bash completed]")
  })

  test("falls back to a native session lookup for unknown hub entries", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    fake.sessionInfo.set("ses_liveonly0001", {
      id: "ses_liveonly0001",
      title: "live only",
      location: { directory: repo },
    })

    const result = await fake.tools.get("swarm_status")!.execute({ session: "ses_liveonly0001" }, {})
    expect(result.content).toContain("live only")
  })

  test("reports unknown sessions without failing", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    const result = await fake.tools.get("swarm_status")!.execute({ session: "ses_missing" }, {})
    expect(result.content).toContain("no session matching")
  })

  test("renders the session tree with rollups and orphan markers", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    fake.stream.push("session.created", { sessionID: "ses_treeroot00001", location: { directory: repo }, title: "tree root" })
    fake.stream.push("session.created", {
      sessionID: "ses_treechild001",
      parentID: "ses_treeroot00001",
      location: { directory: repo },
      title: "tree child",
    })
    fake.stream.push("session.status", { sessionID: "ses_treechild001", status: { type: "busy" } })
    fake.stream.push("session.created", {
      sessionID: "ses_treeorphan01",
      parentID: "ses_gone000000001",
      location: { directory: repo },
      title: "tree orphan",
    })
    expect(await waitFor(() => hubEvents(stateDir).some((event) => event.sessionID === "ses_treeorphan01"))).toBe(true)

    const result = await fake.tools.get("swarm_status")!.execute({ format: "tree" }, {})
    expect(result.content).toContain("tree root")
    expect(result.content).toContain("└ ")
    expect(result.content).toContain("tree child")
    expect(result.content).toContain("subtree")
    expect(result.content).toContain("1 busy")
    expect(result.content).toContain("tree orphan")
    expect(result.content).toContain("orphan")
  })
})

describe("v2 server swarm_send", () => {
  const sender = { sessionID: "ses_sender0000001" }

  test("prompts an idle target with steer delivery and records a pointer", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    fake.stream.push("session.created", {
      sessionID: "ses_sendidle00001",
      location: { directory: repo },
      title: "idle target",
    })
    fake.sessionInfo.set("ses_sendidle00001", { id: "ses_sendidle00001" })
    expect(await waitFor(() => hubEvents(stateDir).some((record) => record.sessionID === "ses_sendidle00001"))).toBe(true)

    const result = await fake.tools.get("swarm_send")!.execute(
      { session: "ses_sendidle", message: "please review  the diff" },
      sender,
    )

    expect(result.content).toContain("prompted")
    expect(fake.prompts.length).toBe(1)
    expect(fake.prompts[0]).toMatchObject({
      sessionID: "ses_sendidle00001",
      text: "please review  the diff",
      delivery: "steer",
    })
    const sent = hubEvents(stateDir).filter((record) => record.kind === "comms.sent")
    expect(sent.length).toBe(1)
    expect(sent[0]?.sessionID).toBe("ses_sendidle00001")
    expect(sent[0]?.refs?.to).toBe("ses_sendidle00001")
    expect(sent[0]?.refs?.from).toBe("ses_sender0000001")
    expect(sent[0]?.refs?.delivery).toBe("prompt")
    expect(sent[0]?.refs?.msgID).toBe("msg_fake0001000000000000000000")
    expect(sent[0]?.summary).toBe("please review the diff")
  })

  test("refuses a busy target without confirm and queues with confirm", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    fake.stream.push("session.created", {
      sessionID: "ses_sendbusy00001",
      location: { directory: repo },
      title: "busy target",
    })
    fake.stream.push("session.execution.started", { sessionID: "ses_sendbusy00001" })
    fake.sessionInfo.set("ses_sendbusy00001", { id: "ses_sendbusy00001" })
    expect(
      await waitFor(
        () => foldSessions(hubEvents(stateDir)).find((node) => node.sessionID === "ses_sendbusy00001")?.status === "busy",
      ),
    ).toBe(true)

    const tool = fake.tools.get("swarm_send")!
    const refused = await tool.execute({ session: "ses_sendbusy00001", message: "hi" }, sender)
    expect(refused.content).toContain("busy")
    expect(refused.metadata?.busy).toBe(true)
    expect(fake.prompts.length).toBe(0)

    const queued = await tool.execute({ session: "ses_sendbusy00001", message: "hi", confirm: true }, sender)
    expect(queued.content).toContain("queued")
    expect(fake.prompts.length).toBe(1)
    expect(fake.prompts[0]).toMatchObject({ sessionID: "ses_sendbusy00001", delivery: "queue" })
    expect(hubEvents(stateDir).filter((record) => record.kind === "comms.sent").length).toBe(1)
  })

  test("pulls the caller inbox and marks pointers seen", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    fake.stream.push("session.created", {
      sessionID: "ses_inboxtarget01",
      location: { directory: repo },
      title: "inbox target",
    })
    fake.sessionInfo.set("ses_inboxtarget01", { id: "ses_inboxtarget01" })
    expect(await waitFor(() => hubEvents(stateDir).some((record) => record.sessionID === "ses_inboxtarget01"))).toBe(true)

    await fake.tools.get("swarm_send")!.execute({ session: "ses_inboxtarget01", message: "status please" }, sender)

    const targetContext = { sessionID: "ses_inboxtarget01" }
    const pulled = await fake.tools.get("swarm_status")!.execute({ inbox: true, format: "json" }, targetContext)
    const parsed = JSON.parse(pulled.content ?? "") as { inbox?: Array<{ msgID: string; from: string; summary: string }> }
    expect(parsed.inbox?.length).toBe(1)
    expect(parsed.inbox?.[0]?.from).toBe("ses_sender0000001")
    expect(parsed.inbox?.[0]?.summary).toBe("status please")
    expect(pulled.metadata?.inbox).toBe(1)
    expect(hubEvents(stateDir).filter((record) => record.kind === "comms.seen").length).toBe(1)

    const second = await fake.tools.get("swarm_status")!.execute({ inbox: true }, targetContext)
    expect(second.content).not.toContain("inbox:")
    expect(second.metadata?.inbox).toBeUndefined()
  })

  test("reports unknown and ambiguous targets without sending", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    fake.stream.push("session.created", { sessionID: "ses_amb000000001", location: { directory: repo } })
    fake.stream.push("session.created", { sessionID: "ses_amb000000002", location: { directory: repo } })
    expect(
      await waitFor(() => hubEvents(stateDir).filter((record) => record.sessionID?.startsWith("ses_amb")).length >= 2),
    ).toBe(true)

    const tool = fake.tools.get("swarm_send")!
    const missing = await tool.execute({ session: "ses_nope", message: "hi" }, sender)
    expect(missing.content).toContain("no session matching")

    const ambiguous = await tool.execute({ session: "ses_amb", message: "hi" }, sender)
    expect(ambiguous.content).toContain("ambiguous")

    const self = await tool.execute({ session: "ses_amb000000001", message: "hi" }, { sessionID: "ses_amb000000001" })
    expect(self.content).toContain("calling session")

    expect(fake.prompts.length).toBe(0)
    expect(hubEvents(stateDir).filter((record) => record.kind === "comms.sent").length).toBe(0)
  })
})

describe("v2 server comms injection", () => {
  test("injects pending inbox into the next prompt and marks delivered", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    fake.stream.push("session.created", {
      sessionID: "ses_injecttarget1",
      location: { directory: repo },
      title: "inject target",
    })
    fake.sessionInfo.set("ses_injecttarget1", { id: "ses_injecttarget1" })
    expect(await waitFor(() => hubEvents(stateDir).some((record) => record.sessionID === "ses_injecttarget1"))).toBe(true)

    const send = fake.tools.get("swarm_send")!
    await send.execute({ session: "ses_injecttarget1", message: "first note" }, { sessionID: "ses_sender0000001" })
    await send.execute({ session: "ses_injecttarget1", message: "second note" }, { sessionID: "ses_sender0000001" })

    const event = { sessionID: "ses_injecttarget1", prompt: { text: "hello" } }
    await fake.runPromptHook(event)
    expect(event.prompt.text).toContain("hello")
    expect(event.prompt.text).toContain("untrusted data")
    expect(event.prompt.text).toContain("first note")
    expect(event.prompt.text).toContain("second note")
    expect(event.prompt.text).toContain("ses_sender0000001")
    expect(hubEvents(stateDir).filter((record) => record.kind === "comms.delivered").length).toBe(2)

    const later = { sessionID: "ses_injecttarget1", prompt: { text: "again" } }
    await fake.runPromptHook(later)
    expect(later.prompt.text).toBe("again")
  })

  test("tails comms written to the hub after bootstrap", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    expect(await waitFor(() => hubEvents(stateDir).some((event) => event.kind === "server.start"))).toBe(true)

    const other = new EventLog(hubRoot(stateDir, PROJECT_ID), "other-server")
    other.append({
      ts: Date.now(),
      serverID: "other-server",
      sessionID: "ses_freshtail0001",
      kind: "comms.sent",
      summary: "fresh pointer summary",
      refs: {
        msgID: "msg_fresh_tail",
        to: "ses_freshtail0001",
        from: "other@host",
        kind: "message",
        delivery: "queue",
      },
    })

    const event = { sessionID: "ses_freshtail0001", prompt: { text: "hi" } }
    await fake.runPromptHook(event)
    expect(event.prompt.text).toContain("fresh pointer summary")
    expect(hubEvents(stateDir).filter((record) => record.kind === "comms.delivered").length).toBe(1)
  })

  test("is a no-op with an empty inbox", async () => {
    const repo = seedRepo([], undefined, false)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    const event = { sessionID: "ses_nobody", prompt: { text: "hi" } }
    await fake.runPromptHook(event)
    expect(event.prompt.text).toBe("hi")
    expect(hubEvents(stateDir).filter((record) => record.kind === "comms.delivered").length).toBe(0)
  })
})
