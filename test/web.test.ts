import { describe, expect, test } from "bun:test"
import { createWebFetch, startWebServer, webView, type WebSource } from "../src/server/web.ts"
import type { MonitorState, SessionNode } from "../src/shared/types.ts"

function session(overrides: Partial<SessionNode> & { sessionID: string }): SessionNode {
  return { kind: "root", status: "idle", lastEventAt: 1000, ...overrides }
}

function monitorState(): MonitorState {
  return {
    generatedAt: 2000,
    hubDir: "/tmp/hub",
    sessions: [
      session({ sessionID: "ses_root00000001", title: "root" }),
      session({ sessionID: "ses_busy000000001", title: "busy", status: "busy" }),
      session({ sessionID: "ses_err0000000001", title: "err", status: "error" }),
      session({ sessionID: "ses_gone000000001", title: "gone", deleted: true }),
    ],
    risks: [],
    recentCommands: [],
    comms: [],
    registry: { claims: [], verifications: [], conflicts: [], errors: [] },
  }
}

function source(overrides: Partial<WebSource> = {}): WebSource {
  return {
    state: () => monitorState(),
    transcript: async (sessionID) =>
      sessionID === "ses_root00000001"
        ? { sessionID, messages: [{ role: "user", text: "hello" }] }
        : undefined,
    ...overrides,
  }
}

describe("web view", () => {
  test("serves the static page", async () => {
    const handler = createWebFetch(source())
    const response = await handler(new Request("http://127.0.0.1:7690/"))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
    expect(await response.text()).toContain("subplug")
  })

  test("serves the folded state with status groups", async () => {
    const handler = createWebFetch(source())
    const response = await handler(new Request("http://127.0.0.1:7690/api/state"))
    const body = (await response.json()) as ReturnType<typeof webView>
    expect(body.sessions).toHaveLength(4)
    expect(body.groups.ses_root00000001).toBe("ready")
    expect(body.groups.ses_busy000000001).toBe("working")
    expect(body.groups.ses_err0000000001).toBe("needs")
    expect(body.groups.ses_gone000000001).toBe("inactive")
    expect(body.groupOrder).toContain("needs")
    expect(body.groupLabels.needs).toBe("Needs input")
  })

  test("rejects writes and unknown paths", async () => {
    const handler = createWebFetch(source())
    const post = await handler(new Request("http://127.0.0.1:7690/api/state", { method: "POST" }))
    expect(post.status).toBe(405)
    const missing = await handler(new Request("http://127.0.0.1:7690/nope"))
    expect(missing.status).toBe(404)
  })

  test("gates on the token when configured", async () => {
    const handler = createWebFetch(source({ token: "s3cret" }))
    expect((await handler(new Request("http://127.0.0.1:7690/api/state"))).status).toBe(401)
    expect((await handler(new Request("http://127.0.0.1:7690/api/state?token=wrong"))).status).toBe(401)
    expect((await handler(new Request("http://127.0.0.1:7690/api/state?token=s3cret"))).status).toBe(200)
  })

  test("serves a transcript and 404s for unknown sessions", async () => {
    const handler = createWebFetch(source())
    const known = await handler(new Request("http://127.0.0.1:7690/api/session/ses_root00000001"))
    expect(known.status).toBe(200)
    expect(await known.json()).toEqual({
      sessionID: "ses_root00000001",
      messages: [{ role: "user", text: "hello" }],
    })
    const missing = await handler(new Request("http://127.0.0.1:7690/api/session/ses_nope00000001"))
    expect(missing.status).toBe(404)
  })

  test("binds localhost on a random port and shuts down", async () => {
    const started = startWebServer(source(), { port: 0 })
    if ("error" in started) throw new Error(started.error)
    try {
      const response = await fetch(`http://127.0.0.1:${started.port}/api/state`)
      expect(response.status).toBe(200)
      expect(started.port).toBeGreaterThan(0)
    } finally {
      started.stop()
    }
  })
})
