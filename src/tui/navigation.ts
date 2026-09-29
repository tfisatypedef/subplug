import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

export function createSessionNavigator(api: TuiPluginApi, route: string, select: (sessionID: string) => void) {
  return async (sessionID: string): Promise<void> => {
    try {
      if (api.state.session.get(sessionID)) {
        api.route.navigate("session", { sessionID })
        return
      }
      // The sync store omits empty sessions; the host client is authoritative.
      const result = await api.client.session.get({ sessionID }, { throwOnError: false })
      if (result.data) {
        api.route.navigate("session", { sessionID })
        return
      }
      const status = result.response?.status
      if (status !== 404) {
        throw result.error ?? new Error(`Session lookup failed (${status ?? "no response"})`)
      }
      select(sessionID)
      api.route.navigate(`${route}.session`, { sessionID })
    } catch (error) {
      api.ui.toast({
        variant: "error",
        title: "subplug",
        message: error instanceof Error ? error.message : "Session lookup failed",
        duration: 5000,
      })
    }
  }
}
