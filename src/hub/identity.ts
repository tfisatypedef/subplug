export const SUBAGENT_ID_LENGTH = 8

export function agentIdentity(base: string, sessionID: string, isSubagent: boolean): string {
  if (!isSubagent) return base
  return `${base}/${sessionID.slice(0, SUBAGENT_ID_LENGTH)}`
}
