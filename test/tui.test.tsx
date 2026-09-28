/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { Dashboard, SessionDetail, Sidebar } from "../src/tui/index.tsx"
import type { MonitorState, SessionNode } from "../src/shared/types.ts"

const WIDTH = 100
const HEIGHT = 30

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

async function renderHosted(node: () => JSX.Element) {
  const setup = await testRender(
    () => (
      <box width={WIDTH} height={HEIGHT} flexDirection="column">
        <box flexGrow={1} minHeight={0} flexDirection="column">
          {node()}
        </box>
      </box>
    ),
    { width: WIDTH, height: HEIGHT },
  )
  await setup.flush()
  return setup
}

function gap(line: string, left: string, right: string): number {
  const leftEnd = line.indexOf(left) + left.length
  return line.indexOf(right) - leftEnd
}

describe("subplug TUI layout", () => {
  test("dashboard sits inside the host shell with full-width rows and panels", async () => {
    const setup = await renderHosted(() => (
      <Dashboard
        api={stubApi()}
        state={monitorState}
        route="subplug"
        command="subplug.open"
        onClose={() => undefined}
        openSession={() => undefined}
        compose={() => undefined}
      />
    ))
    const lines = setup.captureCharFrame().split("\n")

    const header = lines.find((line) => line.includes("swarm dashboard"))
    expect(header).toBeDefined()
    expect(header?.indexOf("subplug")).toBe(2)
    expect(header?.trimEnd().length).toBe(WIDTH - 2)
    expect(header?.trimEnd().endsWith("ago")).toBe(true)

    const title = lines.find((line) => line.includes("Sessions (2)"))
    expect(title?.indexOf("Sessions")).toBe(4)
    expect(title?.trimEnd().endsWith("│")).toBe(true)
    setup.renderer.destroy()
  })

  test("session detail sits inside the host shell with full-width rows and panels", async () => {
    const setup = await renderHosted(() => (
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
    ))
    const lines = setup.captureCharFrame().split("\n")

    const header = lines.find((line) => line.includes("session detail"))
    expect(header).toBeDefined()
    expect(header?.indexOf("subplug")).toBe(2)
    expect(header?.trimEnd().length).toBe(WIDTH - 2)
    expect(header?.trimEnd().endsWith("esc/q back")).toBe(true)

    const conversation = lines.find((line) => line.includes("Conversation ("))
    expect(conversation?.indexOf("Conversation")).toBe(4)
    expect(conversation?.trimEnd().endsWith("│")).toBe(true)
    expect(gap(conversation ?? "", "Conversation (0 rows)", "↑/↓ subagent")).toBeGreaterThan(10)

    const todos = lines.find((line) => line.includes("Todos ("))
    expect(todos?.trimEnd().endsWith("│")).toBe(true)
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
