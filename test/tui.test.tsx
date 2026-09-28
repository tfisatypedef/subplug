/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { Dashboard, SessionDetail, Sidebar } from "../src/tui/index.tsx"
import type { MonitorState, SessionNode } from "../src/shared/types.ts"

function session(overrides: Partial<SessionNode> & { sessionID: string }): SessionNode {
  return { kind: "root", status: "idle", lastEventAt: 1000, ...overrides }
}

function monitorState(): MonitorState {
  return {
    generatedAt: 2000,
    hubDir: "/tmp/hub",
    sessions: [
      session({ sessionID: "ses_root00000001", title: "root session" }),
      session({ sessionID: "ses_child0000001", title: "child session", kind: "subagent", parentID: "ses_root00000001" }),
    ],
    risks: [],
    recentCommands: [],
    comms: [],
    registry: { claims: [], verifications: [], conflicts: [], errors: [] },
  }
}

function stubApi(): TuiPluginApi {
  return {
    theme: {
      current: {
        backgroundPanel: "#000000",
        border: "#333333",
        text: "#ffffff",
        textMuted: "#888888",
        primary: "#5f87ff",
        error: "#ff0000",
        warning: "#ffaa00",
        success: "#00ff00",
      },
    },
    kv: { get: () => [], set: () => undefined },
    keymap: { registerLayer: () => () => undefined },
    state: {
      session: { get: () => undefined },
      part: () => [],
      provider: { find: () => undefined },
    },
    client: {
      session: {
        todo: async () => ({ data: [] }),
        messages: async () => ({ data: [] }),
      },
    },
  } as unknown as TuiPluginApi
}

function gap(line: string, left: string, right: string): number {
  const leftEnd = line.indexOf(left) + left.length
  return line.indexOf(right) - leftEnd
}

describe("subplug TUI layout", () => {
  test("right-aligns the dashboard header and spans the panels", async () => {
    const setup = await testRender(
      () => (
        <Dashboard
          api={stubApi()}
          state={monitorState}
          route="subplug"
          command="subplug.open"
          onClose={() => undefined}
          openSession={() => undefined}
          compose={() => undefined}
        />
      ),
      { width: 100, height: 30 },
    )
    await setup.flush()
    const lines = setup.captureCharFrame().split("\n")

    const header = lines.find((line) => line.includes("swarm dashboard"))
    expect(header).toBeDefined()
    expect(gap(header ?? "", "swarm dashboard", "updated ")).toBeGreaterThan(20)

    const title = lines.find((line) => line.includes("Sessions (2)"))
    expect(title?.trimEnd().at(-1)).toBe("│")
    setup.renderer.destroy()
  })

  test("right-aligns the session detail headers and spans the panels", async () => {
    const setup = await testRender(
      () => (
        <SessionDetail
          api={stubApi()}
          state={monitorState}
          sessionID={() => "ses_root00000001"}
          trail={() => ["ses_root00000001"]}
          descend={() => undefined}
          back={() => undefined}
          compose={() => undefined}
          intervalMs={60_000}
        />
      ),
      { width: 100, height: 30 },
    )
    await setup.flush()
    const lines = setup.captureCharFrame().split("\n")

    const header = lines.find((line) => line.includes("session detail"))
    expect(header).toBeDefined()
    expect(gap(header ?? "", "session detail", "esc/q back")).toBeGreaterThan(20)

    const conversation = lines.find((line) => line.includes("Conversation ("))
    expect(conversation).toBeDefined()
    expect(gap(conversation ?? "", "Conversation (0 rows)", "↑/↓ subagent")).toBeGreaterThan(10)

    const todos = lines.find((line) => line.includes("Todos ("))
    expect(todos?.trimEnd().at(-1)).toBe("│")
    setup.renderer.destroy()
  })

  test("sidebar shows the open hint and forwards clicks", async () => {
    let opened = 0
    const setup = await testRender(
      () => <Sidebar state={monitorState} sessionID="ses_root00000001" onOpen={() => (opened += 1)} />,
      { width: 40, height: 12 },
    )
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("ctrl+alt+a")

    setup.mockMouse.click(5, 3)
    await setup.renderOnce()
    expect(opened).toBe(1)
    setup.renderer.destroy()
  })
})
