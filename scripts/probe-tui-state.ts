import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const probe: TuiPlugin = async (api) => {
  const probeDir = process.env.SUBPLUG_PROBE_DIR ?? api.state.path.state
  const write = (data: Record<string, unknown>): void => {
    try {
      mkdirSync(probeDir, { recursive: true })
      writeFileSync(join(probeDir, "tui-state-probe.json"), `${JSON.stringify({ at: Date.now(), ...data }, null, 2)}\n`)
    } catch {
      // diagnostic only
    }
  }

  setTimeout(async () => {
    try {
      const root = await api.client.session.create({ title: "probe root" })
      const rootID = root.data?.id
      const child = rootID ? await api.client.session.create({ parentID: rootID, title: "probe child" }) : undefined
      const childID = child?.data?.id
      const prompt = childID
        ? await api.client.session.prompt({
            sessionID: childID,
            noReply: true,
            parts: [{ type: "text", text: "PROBE_TUI_STATE" }],
          })
        : undefined
      await new Promise((resolve) => setTimeout(resolve, 2500))
      const viaClient = childID ? await api.client.session.messages({ sessionID: childID }) : undefined
      const storeMessages = childID ? api.state.session.messages(childID) : []
      const storeParts = storeMessages.at(-1)?.id ? api.state.part(storeMessages.at(-1)!.id) : []
      write({
        count: api.state.session.count(),
        childStoreParts: storeParts.length,
        childStorePartTypes: storeParts.map((part) => part.type),
        root: rootID
          ? {
              id: rootID,
              inStore: Boolean(api.state.session.get(rootID)),
              messages: api.state.session.messages(rootID).length,
            }
          : undefined,
        child: childID
          ? {
              id: childID,
              inStore: Boolean(api.state.session.get(childID)),
              messages: api.state.session.messages(childID).length,
              status: api.state.session.status(childID)?.type,
            }
          : undefined,
        viaClientChildMessages: viaClient?.data?.length,
        createError: root.error ? String(root.error) : undefined,
        promptError: prompt?.error ? String(prompt.error) : undefined,
      })
    } catch (error) {
      write({ error: String(error) })
    }
  }, 2500)
}

const plugin: TuiPluginModule & { id: string } = {
  id: "subplug-probe-tui-state",
  tui: probe,
}

export default plugin
