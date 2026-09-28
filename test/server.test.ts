import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import serverModule, { STATE_DIR_TIMEOUT_MS, stateDirTimeoutMs } from "../src/server/index.ts"
import { EventLog, readEventRecords } from "../src/hub/append.ts"
import { fallbackStateDir, hubRoot } from "../src/hub/paths.ts"
import type { EventRecord } from "../src/shared/types.ts"

const PROJECT_ID = "subplug-test-project"
const sessionsRoot = join(tmpdir(), "subplug-server-tests")
mkdirSync(sessionsRoot, { recursive: true })

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

function seedRepo(claimFiles: string[], sessionID?: string): string {
  const repo = tempDir("repo-")
  mkdirSync(join(repo, "coordination", "claims"), { recursive: true })
  git(repo, ["init", "-q"])
  git(repo, ["config", "user.name", "Harness Agent"])
  git(repo, ["config", "user.email", "harness@testhost"])
  writeFileSync(join(repo, "README.md"), "# repo\n")
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
  return repo
}

type FakeSession = {
  id: string
  projectID?: string
  directory?: string
  parentID?: string
  title?: string
  cost?: number
  time?: { created?: number; updated?: number }
}

type FakeMessages = Record<string, Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>>
type FakeTodos = Record<string, Array<{ content: string; status: string }>>
type FakePrompt = {
  path: { id: string }
  body: { parts: Array<{ type: string; text: string }>; noReply?: boolean; messageID?: string }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

async function startPlugin(
  repo: string,
  stateDir: string,
  options: {
    pathGetFailures?: number
    pathGetHangs?: boolean
    stateFromClient?: boolean
    hubGroup?: string
    sessions?: FakeSession[]
    children?: Record<string, FakeSession[]>
    statuses?: Record<string, { type: string }>
    messages?: FakeMessages
    todos?: FakeTodos
    prompts?: FakePrompt[]
  } = {},
): Promise<Hooks> {
  delete process.env.COORD_AGENT_ID
  let remainingFailures = options.pathGetFailures ?? 0
  const input = {
    client: {
      path: {
        get: async () => {
          if (options.pathGetHangs) return new Promise<never>(() => undefined)
          if (remainingFailures > 0) {
            remainingFailures -= 1
            throw new Error("server not ready")
          }
          return { data: { state: stateDir } }
        },
      },
      session: {
        get: async (request: { path: { id: string } }) => ({ data: options.sessions?.find((session) => session.id === request.path.id) ?? { id: request.path.id } }),
        list: async () => ({ data: options.sessions ?? [] }),
        children: async (request: { path: { id: string } }) => ({ data: options.children?.[request.path.id] ?? [] }),
        status: async () => ({ data: options.statuses ?? {} }),
        todo: async (request: { path: { id: string } }) => ({ data: options.todos?.[request.path.id] ?? [] }),
        messages: async (request: { path: { id: string } }) => ({ data: options.messages?.[request.path.id] ?? [] }),
        prompt: async (request: FakePrompt) => {
          options.prompts?.push(request)
          return { data: { info: { id: request.body.messageID ?? "msg_test" }, parts: [] } }
        },
        promptAsync: async (request: FakePrompt) => {
          options.prompts?.push(request)
          return { data: undefined }
        },
      },
    },
    project: { id: PROJECT_ID },
    directory: repo,
    worktree: repo,
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://127.0.0.1:1"),
    $: Bun.$,
  } as unknown as PluginInput
  const pluginOptions: Record<string, unknown> = { coord: { injectIdentity: true } }
  if (!options.stateFromClient) pluginOptions.storageDir = stateDir
  if (options.hubGroup) pluginOptions.hubGroup = options.hubGroup
  return serverModule.server(input, pluginOptions)
}

function hubEvents(stateDir: string): EventRecord[] {
  return readEventRecords(hubRoot(stateDir, PROJECT_ID))
}

function stage(repo: string): void {
  writeFileSync(join(repo, "covered.txt"), "covered\n")
  writeFileSync(join(repo, "uncovered.txt"), "uncovered\n")
  git(repo, ["add", "covered.txt", "uncovered.txt"])
}

describe("server plugin coverage risk", () => {
  test("records command.risk for a commit with uncovered staged paths", async () => {
    const repo = seedRepo(["covered.txt"], "ses_roottest00001")
    const stateDir = tempDir("state-")
    const hooks = await startPlugin(repo, stateDir)
    stage(repo)

    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses_roottest00001", callID: "call-1" },
      { args: { command: 'git commit -m "test"' } },
    )

    const risks = hubEvents(stateDir).filter((event) => event.kind === "command.risk")
    expect(risks.length).toBe(1)
    expect(risks[0]?.refs?.category).toBe("git-commit")
    expect(risks[0]?.refs?.uncovered).toBe(1)
    expect(risks[0]?.summary).toContain("uncovered")
  })

  test("records no risk when every staged path is covered", async () => {
    const repo = seedRepo(["covered.txt", "uncovered.txt"], "ses_roottest00002")
    const stateDir = tempDir("state-")
    const hooks = await startPlugin(repo, stateDir)
    stage(repo)

    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses_roottest00002", callID: "call-2" },
      { args: { command: 'git commit -m "test"' } },
    )

    expect(hubEvents(stateDir).filter((event) => event.kind === "command.risk")).toEqual([])
  })

  test("does not run coverage for non-risky commands", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const hooks = await startPlugin(repo, stateDir)
    stage(repo)

    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses_roottest00003", callID: "call-3" },
      { args: { command: "ls -la" } },
    )

    expect(hubEvents(stateDir).filter((event) => event.kind === "command.risk")).toEqual([])
  })
})

describe("server plugin state dir", () => {
  test("ignores non-positive or non-numeric timeouts", () => {
    for (const raw of [undefined, "", "abc", "0", "-5", "Infinity"]) {
      expect(stateDirTimeoutMs(raw)).toBe(STATE_DIR_TIMEOUT_MS)
    }
    expect(stateDirTimeoutMs("50")).toBe(50)
    expect(stateDirTimeoutMs(250)).toBe(250)
  })

  test("retries path.get before falling back", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const hooks = await startPlugin(repo, stateDir, { pathGetFailures: 2, stateFromClient: true })

    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses_retry00000001", callID: "call-retry" },
      { args: { command: "ls -la" } },
    )

    expect(hubEvents(stateDir).length).toBeGreaterThan(0)
  })

  test("uses the hubGroup override for the hub directory", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const hooks = await startPlugin(repo, stateDir, { hubGroup: "shared-swarm" })

    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses_group00000001", callID: "call-group" },
      { args: { command: "ls -la" } },
    )

    expect(readEventRecords(hubRoot(stateDir, "shared-swarm")).length).toBeGreaterThan(0)
    expect(readEventRecords(hubRoot(stateDir, PROJECT_ID)).length).toBe(0)
  })

  test("falls back when path.get hangs", async () => {
    const previousXdg = process.env.XDG_STATE_HOME
    const previousTimeout = process.env.SUBPLUG_STATE_DIR_TIMEOUT_MS
    const xdg = tempDir("xdg-")
    process.env.XDG_STATE_HOME = xdg
    process.env.SUBPLUG_STATE_DIR_TIMEOUT_MS = "50"
    try {
      const repo = seedRepo([])
      const unused = tempDir("unused-")
      const hooks = await startPlugin(repo, unused, { pathGetHangs: true, stateFromClient: true })

      await hooks["tool.execute.before"]?.(
        { tool: "bash", sessionID: "ses_hang000000001", callID: "call-hang" },
        { args: { command: "ls -la" } },
      )

      expect(readEventRecords(hubRoot(fallbackStateDir(), PROJECT_ID)).length).toBeGreaterThan(0)
      expect(hubEvents(unused).length).toBe(0)
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previousXdg
      if (previousTimeout === undefined) delete process.env.SUBPLUG_STATE_DIR_TIMEOUT_MS
      else process.env.SUBPLUG_STATE_DIR_TIMEOUT_MS = previousTimeout
    }
  })

  test("falls back to the XDG state dir when path.get keeps failing", async () => {
    const previous = process.env.XDG_STATE_HOME
    const xdg = tempDir("xdg-")
    process.env.XDG_STATE_HOME = xdg
    try {
      const repo = seedRepo([])
      const unused = tempDir("unused-")
      const hooks = await startPlugin(repo, unused, { pathGetFailures: 99, stateFromClient: true })

      await hooks["tool.execute.before"]?.(
        { tool: "bash", sessionID: "ses_fallback00001", callID: "call-fallback" },
        { args: { command: "ls -la" } },
      )

      expect(readEventRecords(hubRoot(fallbackStateDir(), PROJECT_ID)).length).toBeGreaterThan(0)
      expect(hubEvents(unused).length).toBe(0)
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
    }
  })
})

describe("server plugin identity", () => {
  test("every session appends its full session id to the base", async () => {
    const rootID = "ses_root00000000001"
    const childID = "ses_child0000000001"
    const expectedRootIdentity = `${identity()}/${rootID}`
    const expectedChildIdentity = `${identity()}/${childID}`

    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const hooks = await startPlugin(repo, stateDir)
    const onEvent = hooks.event as unknown as (input: { event: unknown }) => Promise<void>

    await onEvent({
      event: { type: "session.created", properties: { info: { id: rootID, title: "root", directory: repo } } },
    })
    await onEvent({
      event: {
        type: "session.created",
        properties: { info: { id: childID, title: "child", directory: repo, parentID: rootID } },
      },
    })

    const rootOutput = { env: {} as Record<string, string> }
    await hooks["shell.env"]?.({ cwd: repo, sessionID: rootID }, rootOutput)
    expect(rootOutput.env.COORD_AGENT_ID).toBe(expectedRootIdentity)

    const childOutput = { env: {} as Record<string, string> }
    await hooks["shell.env"]?.({ cwd: repo, sessionID: childID }, childOutput)
    expect(childOutput.env.COORD_AGENT_ID).toBe(expectedChildIdentity)
    expect(childOutput.env.COORD_AGENT_ID).not.toBe(rootOutput.env.COORD_AGENT_ID)

    const identities = hubEvents(stateDir).filter((event) => event.kind === "session.identity")
    expect(
      identities.some(
        (event) => event.sessionID === rootID && event.refs?.identity === expectedRootIdentity,
      ),
    ).toBe(true)
    expect(
      identities.some(
        (event) => event.sessionID === childID && event.refs?.identity === expectedChildIdentity,
      ),
    ).toBe(true)
  })
})

describe("server plugin baseline import", () => {
  test("recovers nested subagents absent from the session list", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const root = { id: "ses_recoveredroot", projectID: PROJECT_ID, directory: repo, time: { updated: Date.now() } }
    const child = { ...root, id: "ses_recoveredchild", parentID: root.id, title: "child" }
    const grandchild = { ...root, id: "ses_recoveredgrandchild", parentID: child.id, title: "grandchild" }
    const hooks = await startPlugin(repo, stateDir, {
      sessions: [root],
      children: { [root.id]: [child], [child.id]: [grandchild], [grandchild.id]: [root] },
      statuses: { [grandchild.id]: { type: "busy" } },
    })
    expect(await waitFor(() => hubEvents(stateDir).some((event) => event.sessionID === grandchild.id && event.kind === "session.status"))).toBe(true)
    const status = (hooks.tool as unknown as Record<string, { execute: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<{ output: string }> }>)["swarm_status"]!
    const result = await status.execute({ format: "json" }, { sessionID: root.id, directory: repo })
    const sessions = JSON.parse(result.output).sessions as Array<{ sessionID: string; parentID?: string; kind: string; status: string }>
    expect(sessions.find((session) => session.sessionID === child.id)).toMatchObject({ parentID: root.id, kind: "subagent", status: "idle" })
    expect(sessions.find((session) => session.sessionID === grandchild.id)).toMatchObject({ parentID: child.id, kind: "subagent", status: "busy" })
    expect(sessions.filter((session) => session.sessionID === root.id)).toHaveLength(1)
  })

  test("recognizes a live task child from native tool metadata", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const hooks = await startPlugin(repo, stateDir)
    await hooks.event?.({ event: {
      type: "message.part.updated",
      properties: { part: {
        id: "prt_task", messageID: "msg_task", sessionID: "ses_taskparent", type: "tool", tool: "task", callID: "call_task",
        state: { status: "running", title: "Review changes", time: { start: Date.now() },
          input: { description: "Review changes", subagent_type: "explore", prompt: "PRIVATE_TASK_BODY" },
          metadata: { sessionId: "ses_taskchild", parentSessionId: "ses_taskparent", model: { modelID: "test-model" } },
        },
      } },
    } })
    const events = hubEvents(stateDir)
    expect(events.find((event) => event.sessionID === "ses_taskchild")).toMatchObject({
      parentID: "ses_taskparent", refs: { agent: "explore", model: "test-model", title: "Review changes" },
    })
    expect(JSON.stringify(events)).not.toContain("PRIVATE_TASK_BODY")
  })

  test("imports existing sessions and statuses at bootstrap", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const now = Date.now()
    await startPlugin(repo, stateDir, {
      sessions: [
        {
          id: "ses_baseline_root01",
          projectID: PROJECT_ID,
          directory: repo,
          title: "existing root",
          time: { created: now - 60_000, updated: now - 30_000 },
        },
        {
          id: "ses_baseline_child1",
          projectID: PROJECT_ID,
          directory: repo,
          parentID: "ses_baseline_root01",
          title: "existing child",
          time: { created: now - 50_000, updated: now - 20_000 },
        },
      ],
      statuses: { ses_baseline_root01: { type: "busy" } },
    })

    const ready = await waitFor(() => hubEvents(stateDir).some((event) => event.sessionID === "ses_baseline_child1"))
    expect(ready).toBe(true)
    const events = hubEvents(stateDir)
    expect(
      events.some(
        (event) =>
          event.kind === "session.status" && event.sessionID === "ses_baseline_root01" && event.refs?.status === "busy",
      ),
    ).toBe(true)
    const child = events.find((event) => event.sessionID === "ses_baseline_child1")
    expect(child?.parentID).toBe("ses_baseline_root01")
    expect(child?.refs?.title).toBe("existing child")
  })

  test("skips sessions older than maxAgeMs", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const stale = Date.now() - 25 * 60 * 60 * 1000
    await startPlugin(repo, stateDir, {
      sessions: [
        {
          id: "ses_stale00000001",
          projectID: PROJECT_ID,
          directory: repo,
          title: "ancient",
          time: { created: stale, updated: stale },
        },
      ],
    })

    const serverStarted = await waitFor(() => hubEvents(stateDir).some((event) => event.kind === "server.start"))
    expect(serverStarted).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(hubEvents(stateDir).some((event) => event.sessionID === "ses_stale00000001")).toBe(false)
  })
})

describe("server plugin session cost", () => {
  test("records cost from live session.updated events", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const hooks = await startPlugin(repo, stateDir)
    const onEvent = hooks.event as unknown as (input: { event: unknown }) => Promise<void>

    await onEvent({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_costlive000001", title: "cost live", directory: repo, cost: 2.5 } },
      },
    })

    const event = hubEvents(stateDir).find((record) => record.sessionID === "ses_costlive000001")
    expect(event?.refs?.cost).toBe(2.5)
  })

  test("carries cost from the baseline listing", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const now = Date.now()
    await startPlugin(repo, stateDir, {
      sessions: [
        {
          id: "ses_costbase000001",
          projectID: PROJECT_ID,
          directory: repo,
          title: "cost baseline",
          cost: 1.25,
          time: { created: now - 60_000, updated: now - 30_000 },
        },
      ],
    })

    const ready = await waitFor(() => hubEvents(stateDir).some((record) => record.sessionID === "ses_costbase000001"))
    expect(ready).toBe(true)
    const event = hubEvents(stateDir).find((record) => record.sessionID === "ses_costbase000001")
    expect(event?.refs?.cost).toBe(1.25)
  })
})

describe("server plugin swarm_status detail", () => {
  type ToolExecutor = {
    execute: (
      args: Record<string, unknown>,
      context: Record<string, unknown>,
    ) => Promise<{ output: string; metadata?: Record<string, unknown> }>
  }

  function swarmTool(hooks: Hooks): ToolExecutor {
    return (hooks.tool as unknown as Record<string, ToolExecutor>)["swarm_status"]!
  }

  test("returns session detail and gates messages behind the messages arg", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const now = Date.now()
    const hooks = await startPlugin(repo, stateDir, {
      sessions: [
        { id: "ses_detail0000001", projectID: PROJECT_ID, directory: repo, title: "detail root", time: { updated: now } },
      ],
      todos: { ses_detail0000001: [{ content: "review claims", status: "in_progress" }] },
      messages: {
        ses_detail0000001: [
          {
            info: { role: "assistant", modelID: "test/model" },
            parts: [
              { type: "text", text: "working on it" },
              { type: "tool", tool: "bash", state: { status: "completed" } },
            ],
          },
        ],
      },
    })

    const seeded = await waitFor(() => hubEvents(stateDir).some((event) => event.sessionID === "ses_detail0000001"))
    expect(seeded).toBe(true)
    const tool = swarmTool(hooks)

    const withoutMessages = await tool.execute({ session: "ses_detail0000001" }, { directory: repo, worktree: repo })
    expect(withoutMessages.output).toContain("detail root")
    expect(withoutMessages.output).toContain("review claims")
    expect(withoutMessages.output).not.toContain("working on it")

    const withMessages = await tool.execute(
      { session: "ses_detail0000001", messages: 5 },
      { directory: repo, worktree: repo },
    )
    expect(withMessages.output).toContain("working on it")
    expect(withMessages.output).toContain("[tool bash completed]")
  })

  test("reports unknown sessions without failing", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const hooks = await startPlugin(repo, stateDir)
    const tool = swarmTool(hooks)

    const result = await tool.execute({ session: "ses_missing" }, { directory: repo, worktree: repo })
    expect(result.output).toContain("no session matching")
  })

  test("renders the session tree with rollups and orphan markers", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const hooks = await startPlugin(repo, stateDir)
    const onEvent = hooks.event as unknown as (input: { event: unknown }) => Promise<void>

    await onEvent({
      event: { type: "session.created", properties: { info: { id: "ses_treeroot00001", title: "tree root", directory: repo } } },
    })
    await onEvent({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_treechild001", title: "tree child", parentID: "ses_treeroot00001", directory: repo } },
      },
    })
    await onEvent({
      event: { type: "session.status", properties: { sessionID: "ses_treechild001", status: { type: "busy" } } },
    })
    await onEvent({
      event: { type: "session.created", properties: { info: { id: "ses_treeorphan01", title: "tree orphan", parentID: "ses_gone000000001", directory: repo } } },
    })

    const tool = swarmTool(hooks)
    const result = await tool.execute({ format: "tree" }, { directory: repo, worktree: repo })

    expect(result.output).toContain("tree root")
    expect(result.output).toContain("└ ")
    expect(result.output).toContain("tree child")
    expect(result.output).toContain("subtree")
    expect(result.output).toContain("1 busy")
    expect(result.output).toContain("tree orphan")
    expect(result.output).toContain("orphan")
  })
})

describe("server plugin swarm_send", () => {
  type SendExecutor = {
    execute: (
      args: Record<string, unknown>,
      context: Record<string, unknown>,
    ) => Promise<{ output: string; metadata?: Record<string, unknown> }>
  }

  function sendTool(hooks: Hooks): SendExecutor {
    return (hooks.tool as unknown as Record<string, SendExecutor>)["swarm_send"]!
  }

  const sender = { sessionID: "ses_sender0000001" }

  test("prompts an idle target and records a comms.sent pointer", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const now = Date.now()
    const prompts: FakePrompt[] = []
    const hooks = await startPlugin(repo, stateDir, {
      sessions: [
        {
          id: "ses_sendidle00001",
          projectID: PROJECT_ID,
          directory: repo,
          title: "idle target",
          time: { created: now - 10_000, updated: now - 5_000 },
        },
      ],
      statuses: { ses_sendidle00001: { type: "idle" } },
      prompts,
    })
    const seeded = await waitFor(() => hubEvents(stateDir).some((record) => record.sessionID === "ses_sendidle00001"))
    expect(seeded).toBe(true)

    const result = await sendTool(hooks).execute(
      { session: "ses_sendidle", message: "please review  the diff" },
      { ...sender, directory: repo, worktree: repo },
    )

    expect(result.output).toContain("prompted")
    expect(prompts.length).toBe(1)
    expect(prompts[0]?.path.id).toBe("ses_sendidle00001")
    expect(prompts[0]?.body.noReply).toBe(false)
    expect(prompts[0]?.body.parts[0]?.text).toBe("please review  the diff")

    const sent = hubEvents(stateDir).filter((record) => record.kind === "comms.sent")
    expect(sent.length).toBe(1)
    expect(sent[0]?.sessionID).toBe("ses_sendidle00001")
    expect(sent[0]?.refs?.to).toBe("ses_sendidle00001")
    expect(sent[0]?.refs?.from).toBe("ses_sender0000001")
    expect(sent[0]?.refs?.delivery).toBe("prompt")
    expect(sent[0]?.summary).toBe("please review the diff")
  })

  test("refuses a busy target without confirm and queues with confirm", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const now = Date.now()
    const prompts: FakePrompt[] = []
    const hooks = await startPlugin(repo, stateDir, {
      sessions: [
        {
          id: "ses_sendbusy00001",
          projectID: PROJECT_ID,
          directory: repo,
          title: "busy target",
          time: { created: now - 10_000, updated: now - 5_000 },
        },
      ],
      statuses: { ses_sendbusy00001: { type: "busy" } },
      prompts,
    })
    const seeded = await waitFor(() =>
      hubEvents(stateDir).some(
        (record) => record.kind === "session.status" && record.sessionID === "ses_sendbusy00001",
      ),
    )
    expect(seeded).toBe(true)

    const tool = sendTool(hooks)
    const refused = await tool.execute(
      { session: "ses_sendbusy00001", message: "hi" },
      { ...sender, directory: repo, worktree: repo },
    )
    expect(refused.output).toContain("busy")
    expect(refused.metadata?.busy).toBe(true)
    expect(prompts.length).toBe(0)

    const queued = await tool.execute(
      { session: "ses_sendbusy00001", message: "hi", confirm: true },
      { ...sender, directory: repo, worktree: repo },
    )
    expect(queued.output).toContain("queued")
    expect(prompts.length).toBe(1)
    expect(prompts[0]?.body.noReply).toBe(true)
    expect(hubEvents(stateDir).filter((record) => record.kind === "comms.sent").length).toBe(1)
  })

  test("pulls the caller inbox and marks pointers seen", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const now = Date.now()
    const prompts: FakePrompt[] = []
    const hooks = await startPlugin(repo, stateDir, {
      sessions: [
        {
          id: "ses_inboxtarget01",
          projectID: PROJECT_ID,
          directory: repo,
          title: "inbox target",
          time: { created: now - 10_000, updated: now - 5_000 },
        },
      ],
      statuses: { ses_inboxtarget01: { type: "idle" } },
      prompts,
    })
    const seeded = await waitFor(() => hubEvents(stateDir).some((record) => record.sessionID === "ses_inboxtarget01"))
    expect(seeded).toBe(true)

    const tools = hooks.tool as unknown as Record<string, SendExecutor>
    await tools["swarm_send"]!.execute(
      { session: "ses_inboxtarget01", message: "status please" },
      { sessionID: "ses_sender0000001", directory: repo, worktree: repo },
    )

    const targetContext = { sessionID: "ses_inboxtarget01", directory: repo, worktree: repo }
    const pulled = await tools["swarm_status"]!.execute({ inbox: true, format: "json" }, targetContext)
    const parsed = JSON.parse(pulled.output) as { inbox?: Array<{ msgID: string; from: string; summary: string }> }
    expect(parsed.inbox?.length).toBe(1)
    expect(parsed.inbox?.[0]?.from).toBe("ses_sender0000001")
    expect(parsed.inbox?.[0]?.summary).toBe("status please")
    expect(pulled.metadata?.inbox).toBe(1)
    expect(hubEvents(stateDir).filter((record) => record.kind === "comms.seen").length).toBe(1)

    const second = await tools["swarm_status"]!.execute({ inbox: true }, targetContext)
    expect(second.output).not.toContain("inbox:")
    expect(second.metadata?.inbox).toBeUndefined()
  })

  test("reports unknown and ambiguous targets without sending", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const now = Date.now()
    const prompts: FakePrompt[] = []
    const hooks = await startPlugin(repo, stateDir, {
      sessions: [
        { id: "ses_amb000000001", projectID: PROJECT_ID, directory: repo, title: "amb one", time: { updated: now } },
        { id: "ses_amb000000002", projectID: PROJECT_ID, directory: repo, title: "amb two", time: { updated: now } },
      ],
      prompts,
    })
    const seeded = await waitFor(() => hubEvents(stateDir).filter((record) => record.sessionID?.startsWith("ses_amb")).length >= 2)
    expect(seeded).toBe(true)

    const tool = sendTool(hooks)
    const missing = await tool.execute({ session: "ses_nope", message: "hi" }, { ...sender, directory: repo, worktree: repo })
    expect(missing.output).toContain("no session matching")

    const ambiguous = await tool.execute({ session: "ses_amb", message: "hi" }, { ...sender, directory: repo, worktree: repo })
    expect(ambiguous.output).toContain("ambiguous")

    const self = await tool.execute(
      { session: "ses_amb000000001", message: "hi" },
      { sessionID: "ses_amb000000001", directory: repo, worktree: repo },
    )
    expect(self.output).toContain("calling session")

    expect(prompts.length).toBe(0)
    expect(hubEvents(stateDir).filter((record) => record.kind === "comms.sent").length).toBe(0)
  })
})

describe("server plugin comms injection", () => {
  type MessageHook = (input: Record<string, unknown>, output: Record<string, unknown>) => Promise<void>
  type SendExecutor = {
    execute: (
      args: Record<string, unknown>,
      context: Record<string, unknown>,
    ) => Promise<{ output: string; metadata?: Record<string, unknown> }>
  }

  test("injects pending inbox as one synthetic part and marks delivered", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const now = Date.now()
    const prompts: FakePrompt[] = []
    const hooks = await startPlugin(repo, stateDir, {
      sessions: [
        {
          id: "ses_injecttarget1",
          projectID: PROJECT_ID,
          directory: repo,
          title: "inject target",
          time: { created: now - 10_000, updated: now - 5_000 },
        },
      ],
      statuses: { ses_injecttarget1: { type: "idle" } },
      prompts,
    })
    const seeded = await waitFor(() => hubEvents(stateDir).some((record) => record.sessionID === "ses_injecttarget1"))
    expect(seeded).toBe(true)

    const tools = hooks.tool as unknown as Record<string, SendExecutor>
    const senderContext = { sessionID: "ses_sender0000001", directory: repo, worktree: repo }
    await tools["swarm_send"]!.execute({ session: "ses_injecttarget1", message: "first note" }, senderContext)
    await tools["swarm_send"]!.execute({ session: "ses_injecttarget1", message: "second note" }, senderContext)

    const onMessage = hooks["chat.message"] as unknown as MessageHook
    const parts: Array<Record<string, unknown>> = []
    await onMessage(
      { sessionID: "ses_injecttarget1", agent: "build" },
      { message: { id: "msg_user00000001" }, parts },
    )

    expect(parts.length).toBe(1)
    expect(parts[0]).toMatchObject({
      type: "text",
      synthetic: true,
      sessionID: "ses_injecttarget1",
      messageID: "msg_user00000001",
    })
    const text = String(parts[0]?.text ?? "")
    expect(text).toContain("untrusted data")
    expect(text).toContain("first note")
    expect(text).toContain("second note")
    expect(text).toContain("ses_sender0000001")
    expect(hubEvents(stateDir).filter((record) => record.kind === "comms.delivered").length).toBe(2)

    const later: Array<Record<string, unknown>> = []
    await onMessage({ sessionID: "ses_injecttarget1" }, { message: { id: "msg_user00000002" }, parts: later })
    expect(later.length).toBe(0)
  })

  test("tails comms written to the hub after bootstrap", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const hooks = await startPlugin(repo, stateDir)
    const bootstrapped = await waitFor(() => hubEvents(stateDir).some((event) => event.kind === "server.start"))
    expect(bootstrapped).toBe(true)

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

    const onMessage = hooks["chat.message"] as unknown as MessageHook
    const parts: Array<Record<string, unknown>> = []
    await onMessage({ sessionID: "ses_freshtail0001" }, { message: { id: "msg_user_fresh001" }, parts })

    expect(parts.length).toBe(1)
    expect(String(parts[0]?.text ?? "")).toContain("fresh pointer summary")
    expect(hubEvents(stateDir).filter((record) => record.kind === "comms.delivered").length).toBe(1)

    const later: Array<Record<string, unknown>> = []
    await onMessage({ sessionID: "ses_freshtail0001" }, { message: { id: "msg_user_fresh002" }, parts: later })
    expect(later.length).toBe(0)
  })

  test("is a no-op with an empty inbox", async () => {
    const repo = seedRepo([])
    const stateDir = tempDir("state-")
    const hooks = await startPlugin(repo, stateDir)
    const onMessage = hooks["chat.message"] as unknown as MessageHook
    const parts: Array<Record<string, unknown>> = []
    await onMessage({ sessionID: "ses_nobody" }, { message: { id: "msg_user00000003" }, parts })
    expect(parts.length).toBe(0)
    expect(hubEvents(stateDir).filter((record) => record.kind === "comms.delivered").length).toBe(0)
  })
})
