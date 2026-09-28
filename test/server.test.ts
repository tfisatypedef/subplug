import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import serverModule from "../src/server/index.ts"
import { readEventRecords } from "../src/hub/append.ts"
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

function seedRepo(claimFiles: string[]): string {
  const repo = tempDir("repo-")
  mkdirSync(join(repo, "coordination", "claims"), { recursive: true })
  git(repo, ["init", "-q"])
  git(repo, ["config", "user.name", "Harness Agent"])
  git(repo, ["config", "user.email", "harness@testhost"])
  writeFileSync(join(repo, "README.md"), "# repo\n")
  const claim = {
    event_id: "server-test-claim",
    kind: "claim",
    agent: identity(),
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
  time?: { created?: number; updated?: number }
}

type FakeMessages = Record<string, Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>>
type FakeTodos = Record<string, Array<{ content: string; status: string }>>

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
    stateFromClient?: boolean
    sessions?: FakeSession[]
    statuses?: Record<string, { type: string }>
    messages?: FakeMessages
    todos?: FakeTodos
  } = {},
): Promise<Hooks> {
  delete process.env.COORD_AGENT_ID
  let remainingFailures = options.pathGetFailures ?? 0
  const input = {
    client: {
      path: {
        get: async () => {
          if (remainingFailures > 0) {
            remainingFailures -= 1
            throw new Error("server not ready")
          }
          return { data: { state: stateDir } }
        },
      },
      session: {
        list: async () => ({ data: options.sessions ?? [] }),
        status: async () => ({ data: options.statuses ?? {} }),
        todo: async (request: { path: { id: string } }) => ({ data: options.todos?.[request.path.id] ?? [] }),
        messages: async (request: { path: { id: string } }) => ({ data: options.messages?.[request.path.id] ?? [] }),
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
    const repo = seedRepo(["covered.txt"])
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
    const repo = seedRepo(["covered.txt", "uncovered.txt"])
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
  test("roots stay shared while subagents get a unique suffix", async () => {
    const rootID = "ses_root00000000001"
    const childID = "ses_child0000000001"
    const expectedChildIdentity = `${identity()}/${childID.slice(0, 8)}`

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
    expect(rootOutput.env.COORD_AGENT_ID).toBe(identity())

    const childOutput = { env: {} as Record<string, string> }
    await hooks["shell.env"]?.({ cwd: repo, sessionID: childID }, childOutput)
    expect(childOutput.env.COORD_AGENT_ID).toBe(expectedChildIdentity)
    expect(childOutput.env.COORD_AGENT_ID).not.toBe(identity())

    const identities = hubEvents(stateDir).filter((event) => event.kind === "session.identity")
    expect(identities.some((event) => event.sessionID === rootID)).toBe(true)
    expect(
      identities.some(
        (event) => event.sessionID === childID && event.refs?.identity === expectedChildIdentity,
      ),
    ).toBe(true)
  })
})

describe("server plugin baseline import", () => {
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
})
