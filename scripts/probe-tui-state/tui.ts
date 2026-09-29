import { mkdirSync, writeFileSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin/tui"
import { fallbackStateDir } from "../../src/hub/paths.ts"

type ProbeContext = {
  readonly location?: { readonly directory?: string }
  readonly client: {
    readonly server?: { info: () => Promise<unknown> }
    readonly session: {
      create: (input: { title: string }) => Promise<{ id?: string } | undefined>
      prompt: (input: {
        sessionID: string
        text: string
        resume?: boolean
      }) => Promise<{ id?: string } | undefined>
      context: (input: { sessionID: string }) => Promise<unknown>
      list?: (input?: { limit?: number }) => Promise<unknown>
    }
  }
  readonly data: {
    readonly session: {
      list: () => Array<Record<string, unknown>> | undefined
      get: (sessionID: string) => Record<string, unknown> | undefined
      root?: (sessionID: string) => string
      family?: (sessionID: string) => string[]
      cost?: (sessionID: string) => number
      status: (sessionID: string) => string
      readonly message: {
        list: (sessionID: string) => unknown[]
        sync: (sessionID: string) => Promise<void>
      }
    }
  }
}

function probeDir(): string {
  return process.env.SUBPLUG_PROBE_DIR ?? join(fallbackStateDir(), "subplug")
}

function write(data: Record<string, unknown>): void {
  try {
    mkdirSync(probeDir(), { recursive: true })
    writeFileSync(join(probeDir(), "tui-state-probe.json"), `${JSON.stringify({ at: Date.now(), ...data }, null, 2)}\n`)
  } catch {
    // diagnostic only
  }
}

function safe(value: unknown): unknown {
  if (typeof value === "function") return "[function]"
  return value
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>).data
  }
  return value
}

function localHosts(): string[] {
  const hosts = new Set<string>(["127.0.0.1", "localhost", "::1"])
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) hosts.add(address.address)
  }
  return [...hosts]
}

function urlsOf(info: unknown): string[] {
  const candidate = info && typeof info === "object" ? (info as { urls?: unknown }).urls : undefined
  return Array.isArray(candidate) ? candidate.filter((url): url is string => typeof url === "string") : []
}

export default Plugin.define({
  id: "subplug.probe.tui-state",
  async setup(rawContext) {
    const ctx = rawContext as unknown as ProbeContext
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 2500))
      try {
        const info = await ctx.client.server?.info().catch((error) => ({ error: String(error) }))
        const urls = urlsOf(info)
        const local = new Set(localHosts())
        const remoteHeuristic = urls.length
          ? urls.every((url) => {
              try {
                return !local.has(new URL(url).hostname)
              } catch {
                return true
              }
            })
          : undefined

        const root = await ctx.client.session.create({ title: "probe root" })
        const rootID = root?.id
        const child = rootID ? await ctx.client.session.create({ title: "probe child" }) : undefined
        const childID = child?.id
        const admitted = childID
          ? await ctx.client.session.prompt({ sessionID: childID, text: "PROBE_TUI_STATE", resume: false })
          : undefined
        await new Promise((resolve) => setTimeout(resolve, 2500))
        if (childID) {
          await ctx.data.session.message.sync(childID).catch(() => undefined)
        }
        const context = childID ? await ctx.client.session.context({ sessionID: childID }).catch(() => undefined) : undefined
        const contextRows = Array.isArray(context) ? context : (context as { data?: unknown[] } | undefined)?.data

        const clientListRaw = await ctx.client.session.list?.({ limit: 200 }).catch(() => undefined)
        const clientList = unwrap(unwrap(clientListRaw))
        const storeList = ctx.data.session.list() ?? []

        write({
          location: ctx.location?.directory,
          serverInfo: info === undefined ? undefined : (safe(info) as Record<string, unknown>),
          serverUrls: urls,
          localHosts: [...local],
          remoteHeuristic,
          sessionCount: storeList.length,
          storeList: storeList.slice(0, 5).map((session) => ({
            id: session.id,
            parentID: session.parentID,
            title: session.title,
            agent: session.agent,
            model: (session.model as { id?: string } | undefined)?.id,
            cost: session.cost,
            directory: (session.location as { directory?: string } | undefined)?.directory,
            updated: (session.time as { updated?: number } | undefined)?.updated,
          })),
          clientListCount: Array.isArray(clientList) ? clientList.length : undefined,
          root: rootID
            ? {
                id: rootID,
                inStore: Boolean(ctx.data.session.get(rootID)),
                status: ctx.data.session.status(rootID),
                cost: ctx.data.session.cost?.(rootID),
                root: ctx.data.session.root?.(rootID),
                family: ctx.data.session.family?.(rootID),
              }
            : undefined,
          child: childID
            ? {
                id: childID,
                inStore: Boolean(ctx.data.session.get(childID)),
                parentID: ctx.data.session.get(childID)?.parentID,
                status: ctx.data.session.status(childID),
                cost: ctx.data.session.cost?.(childID),
                root: ctx.data.session.root?.(childID),
                family: ctx.data.session.family?.(childID),
                storeMessages: ctx.data.session.message.list(childID).length,
                contextMessages: Array.isArray(contextRows) ? contextRows.length : undefined,
                admittedID: admitted?.id,
              }
            : undefined,
        })
      } catch (error) {
        write({ error: String(error) })
      }
    })()
    return () => undefined
  },
})
