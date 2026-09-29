import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin/tui"
import { fallbackStateDir } from "../../src/hub/paths.ts"

type ProbeContext = {
  readonly client: {
    readonly session: {
      create: (input: { title: string }) => Promise<{ id?: string } | undefined>
      prompt: (input: {
        sessionID: string
        text: string
        resume?: boolean
      }) => Promise<{ id?: string } | undefined>
      context: (input: { sessionID: string }) => Promise<unknown>
    }
  }
  readonly data: {
    readonly session: {
      list: () => Array<{ id?: string }> | undefined
      get: (sessionID: string) => unknown
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

export default Plugin.define({
  id: "subplug.probe.tui-state",
  async setup(rawContext) {
    const ctx = rawContext as unknown as ProbeContext
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 2500))
      try {
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
        write({
          sessionCount: ctx.data.session.list()?.length,
          root: rootID
            ? {
                id: rootID,
                inStore: Boolean(ctx.data.session.get(rootID)),
              }
            : undefined,
          child: childID
            ? {
                id: childID,
                inStore: Boolean(ctx.data.session.get(childID)),
                status: ctx.data.session.status(childID),
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
