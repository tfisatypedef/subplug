import { describe, expect, test } from "bun:test"
import {
  detectRemote,
  parseRemoteMode,
  serverUrls,
  urlsIndicateRemote,
  type RemoteDeps,
} from "../src/tui/remote.ts"
import { mapRemoteSessions, readRemoteState } from "../src/tui/remote-state.ts"
import type { TuiContextLike } from "../src/tui/context.ts"
import type { V2SessionInfo } from "../src/tui/data.ts"

const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "192.168.1.10"])

function deps(overrides: Partial<RemoteDeps> = {}): RemoteDeps {
  return {
    info: async () => ({ urls: ["http://127.0.0.1:4096"] }),
    localHosts: () => LOCAL,
    directoryExists: () => true,
    ...overrides,
  }
}

function remoteContext(sessions: V2SessionInfo[], status: Record<string, "idle" | "running"> = {}): TuiContextLike {
  return {
    theme: {} as TuiContextLike["theme"],
    attention: { notify: async () => ({ ok: true, notification: false, sound: false }) },
    storage: { store: () => [{}, () => undefined] as never },
    keymap: { layer: () => undefined },
    ui: {
      dialog: { prompt: async () => undefined, confirm: async () => undefined, clear: () => undefined },
      toast: { show: () => undefined },
      router: { register: () => () => undefined, navigate: () => undefined, current: () => ({ type: "home" }) },
      slot: () => () => undefined,
    },
    data: {
      session: {
        list: () => sessions,
        get: (id) => sessions.find((session) => session.id === id),
        status: (id) => status[id] ?? "idle",
        cost: () => 3.5,
        message: { list: () => [], sync: async () => undefined },
      },
    },
    client: {
      session: {
        get: async () => ({ data: {} }),
        context: async () => ({ data: [] }),
        prompt: async () => ({ data: {} }),
      },
    },
  }
}

describe("remote mode parsing", () => {
  test("explicit values win and unknown values default to auto", () => {
    expect(parseRemoteMode(true)).toBe("remote")
    expect(parseRemoteMode(false)).toBe("local")
    expect(parseRemoteMode("remote")).toBe("remote")
    expect(parseRemoteMode(" REMOTE ")).toBe("remote")
    expect(parseRemoteMode("local")).toBe("local")
    expect(parseRemoteMode("1")).toBe("remote")
    expect(parseRemoteMode("0")).toBe("local")
    expect(parseRemoteMode(undefined)).toBe("auto")
    expect(parseRemoteMode("nonsense")).toBe("auto")
  })
})

describe("remote url heuristic", () => {
  test("reads urls from an info payload", () => {
    expect(serverUrls({ urls: ["http://a", 4, "http://b"] })).toEqual(["http://a", "http://b"])
    expect(serverUrls(undefined)).toEqual([])
    expect(serverUrls("nope")).toEqual([])
  })

  test("remote only when every url is foreign", () => {
    expect(urlsIndicateRemote([], LOCAL)).toBeUndefined()
    expect(urlsIndicateRemote(["http://127.0.0.1:4096"], LOCAL)).toBe(false)
    expect(urlsIndicateRemote(["http://192.168.1.10:4096"], LOCAL)).toBe(false)
    expect(urlsIndicateRemote(["http://[::1]:4096"], LOCAL)).toBe(false)
    expect(urlsIndicateRemote(["http://10.0.0.5:4096"], LOCAL)).toBe(true)
    expect(urlsIndicateRemote(["http://10.0.0.5:4096", "http://192.168.1.10:4096"], LOCAL)).toBe(false)
    expect(urlsIndicateRemote(["not a url"], LOCAL)).toBe(true)
  })
})

describe("detectRemote", () => {
  test("explicit mode bypasses the probe", async () => {
    let probed = false
    const spy = deps({
      info: async () => {
        probed = true
        return { urls: [] }
      },
    })
    expect(await detectRemote("remote", "/somewhere", spy)).toBe(true)
    expect(await detectRemote("local", "/somewhere", spy)).toBe(false)
    expect(probed).toBe(false)
  })

  test("auto trusts the urls heuristic", async () => {
    expect(await detectRemote("auto", "/repo", deps())).toBe(false)
    expect(
      await detectRemote("auto", "/repo", deps({ info: async () => ({ urls: ["http://10.0.0.5:4096"] }) })),
    ).toBe(true)
  })

  test("auto falls back to the directory when the endpoint is silent or failing", async () => {
    const silent = deps({ info: async () => ({}) })
    expect(await detectRemote("auto", "/missing", { ...silent, directoryExists: () => false })).toBe(true)
    expect(await detectRemote("auto", "/present", { ...silent, directoryExists: () => true })).toBe(false)

    const failing = deps({
      info: async () => {
        throw new Error("offline")
      },
    })
    expect(await detectRemote("auto", "/missing", { ...failing, directoryExists: () => false })).toBe(true)
    expect(await detectRemote("auto", undefined, failing)).toBe(false)
  })
})

describe("remote state mapping", () => {
  test("maps list rows into SessionNodes and sorts by time", () => {
    const nodes = mapRemoteSessions(
      [
        { id: "ses_root", title: "root task", agent: "build", model: { id: "m/1" }, time: { updated: 200 }, location: { directory: "C:\\remote" } },
        { id: "ses_child", parentID: "ses_root", title: "child", time: { updated: 100 } },
      ],
      { status: (id) => (id === "ses_root" ? "running" : "idle"), cost: () => 2 },
      999,
    )
    expect(nodes.map((node) => node.sessionID)).toEqual(["ses_child", "ses_root"])
    expect(nodes[1]).toMatchObject({
      sessionID: "ses_root",
      kind: "root",
      status: "busy",
      agent: "build",
      model: "m/1",
      title: "root task",
      directory: "C:\\remote",
      cost: 2,
      serverID: "remote",
      lastEventAt: 200,
    })
    expect(nodes[0]).toMatchObject({ kind: "subagent", parentID: "ses_root", status: "idle" })
  })

  test("falls back to the listed cost and to now when time is absent", () => {
    const nodes = mapRemoteSessions([{ id: "ses_a", cost: 1.25 }], { status: () => "idle" }, 42)
    expect(nodes[0]?.cost).toBe(1.25)
    expect(nodes[0]?.lastEventAt).toBe(42)
  })

  test("keeps status unknown when the remote status lookup fails", () => {
    const nodes = mapRemoteSessions([{ id: "ses_a" }], {
      status: () => { throw new Error("unavailable") },
    })
    expect(nodes[0]?.status).toBe("unknown")
  })
})

describe("readRemoteState", () => {
  test("is hub-free, remote-tagged, and carries no claims or comms", () => {
    const ctx = remoteContext([{ id: "ses_root", time: { updated: 5 } }], { ses_root: "running" })
    const state = readRemoteState(ctx, 10)
    expect(state.source).toBe("remote")
    expect(state.hubDir).toBe("")
    expect(state.generatedAt).toBe(10)
    expect(state.risks).toEqual([])
    expect(state.recentCommands).toEqual([])
    expect(state.comms).toEqual([])
    expect(state.registry).toEqual({ claims: [], verifications: [], conflicts: [], errors: [] })
    expect(state.sessions[0]?.status).toBe("busy")
  })

  test("prefers the native list so pre-existing server sessions are included", () => {
    const ctx = remoteContext([{ id: "ses_live", time: { updated: 5 } }])
    const state = readRemoteState(ctx, 10, [
      { id: "ses_live", time: { updated: 5 } },
      { id: "ses_preexisting", title: "older session", time: { updated: 3 } },
    ])
    expect(state.sessions.map((session) => session.sessionID)).toEqual(["ses_preexisting", "ses_live"])
  })

  test("falls back to the reactive store when the native list is empty", () => {
    const ctx = remoteContext([{ id: "ses_store", time: { updated: 5 } }])
    expect(readRemoteState(ctx, 10, []).sessions.map((session) => session.sessionID)).toEqual(["ses_store"])
    expect(readRemoteState(ctx, 10).sessions.map((session) => session.sessionID)).toEqual(["ses_store"])
  })
})
