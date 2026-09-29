import { describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
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

// Execute the actual inline browser script; fetch completion order is controlled
// so selection and polling races exercise the same handlers as the page.
async function browser() {
  class Element {
    children: Element[] = []
    className = ""
    onclick?: () => void
    writes = 0
    private content = ""
    get innerHTML() { return this.content }
    set innerHTML(value: string) { this.content = value; this.children = []; this.writes++ }
    get textContent() { return this.content }
    set textContent(value: string) { this.content = value; this.children = []; this.writes++ }
    appendChild(child: Element) { this.children.push(child) }
  }
  const elements = new Map<string, Element>()
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const requests: { url: string; resolve: (response: Response) => void }[] = []
  let poll!: () => Promise<void>
  const page = await (await createWebFetch(source())(new Request("http://localhost/"))).text()
  runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)![1]!, {
    URLSearchParams, location: { search: "?token=test" },
    document: { getElementById: get, createElement: () => new Element() },
    setInterval: (callback: typeof poll) => { poll = callback },
    fetch: (url: string) => new Promise<Response>((resolve) => requests.push({ url, resolve })),
  })
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
  const respond = async (request: (typeof requests)[number], body: unknown, status = 200) => {
    request.resolve(new Response(JSON.stringify(body), { status }))
    await flush()
  }
  await respond(requests[0]!, webView(monitorState()))
  const click = (index: number) => get("sessions").children[index]!.onclick!()
  const transcript = (text: string) => ({ messages: [{ role: "assistant", text }] })
  return { get, requests, poll, respond, click, transcript }
}

describe("web browser transcript", () => {
  test("applies a slow refresh even when a newer poll is still pending", async () => {
    const b = await browser()
    b.click(0)
    const polling = b.poll()
    await b.respond(b.requests[2]!, webView(monitorState()))
    await b.respond(b.requests[1]!, b.transcript("slow first result"))
    expect(b.get("transcript").innerHTML).toContain("slow first result")
    await b.respond(b.requests[3]!, b.transcript("newer result"))
    await polling
    expect(b.get("transcript").innerHTML).toContain("newer result")
    const failed = b.poll()
    await b.respond(b.requests[4]!, {}, 401)
    await failed
    expect(b.get("meta").textContent).toBe("connection lost")
    expect(b.get("transcript").innerHTML).toContain("newer result")
  })

  test("polls the selected transcript without clearing or rewriting unchanged content", async () => {
    const b = await browser()
    b.click(0)
    expect(b.requests[1]!.url).toBe("/api/session/ses_root00000001?token=test")
    await b.respond(b.requests[1]!, b.transcript("first"))
    const panel = b.get("transcript")
    const writes = panel.writes
    const polling = b.poll()
    await b.respond(b.requests[2]!, webView(monitorState()))
    expect(b.requests[3]!.url).toContain("/api/session/ses_root")
    expect(panel.innerHTML).toContain("first")
    expect(panel.writes).toBe(writes)
    await b.respond(b.requests[3]!, b.transcript("first"))
    await polling
    expect(panel.writes).toBe(writes)
    const next = b.poll()
    await b.respond(b.requests[4]!, webView(monitorState()))
    await b.respond(b.requests[5]!, b.transcript("updated <text>"))
    await next
    expect(panel.innerHTML).toContain("updated &lt;text&gt;")
    const failed = b.poll()
    await b.respond(b.requests[6]!, webView(monitorState()))
    await b.respond(b.requests[7]!, {}, 500)
    await failed
    expect(panel.innerHTML).toContain("updated &lt;text&gt;")
  })

  test("ignores late responses across selections and overlapping same-session refreshes", async () => {
    const b = await browser()
    b.click(0)
    b.click(1)
    await b.respond(b.requests[2]!, b.transcript("busy"))
    await b.respond(b.requests[1]!, b.transcript("stale root"))
    expect(b.get("transcript").innerHTML).toContain("busy")
    b.click(1)
    b.click(1)
    await b.respond(b.requests[4]!, b.transcript("newest"))
    await b.respond(b.requests[3]!, b.transcript("older"))
    expect(b.get("transcript").innerHTML).toContain("newest")
    b.click(0)
    b.click(1)
    await b.respond(b.requests[6]!, b.transcript("returned"))
    await b.respond(b.requests[5]!, {}, 500)
    expect(b.get("transcript").innerHTML).toContain("returned")
  })

  test("ignores an earlier selection even after returning to the same session", async () => {
    const b = await browser()
    b.click(0)
    b.click(1)
    b.click(0)
    await b.respond(b.requests[1]!, b.transcript("earlier visit"))
    expect(b.get("transcript").textContent).toBe("loading...")
    await b.respond(b.requests[3]!, b.transcript("current visit"))
    await b.respond(b.requests[2]!, b.transcript("other session"))
    expect(b.get("transcript").innerHTML).toContain("current visit")
  })
})
