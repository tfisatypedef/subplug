export function agentIdentity(base: string, sessionID: string): string {
  return `${base}/${sessionID}`
}
