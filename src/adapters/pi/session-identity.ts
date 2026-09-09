/** Native Pi identity shared by capture, recovery and stats. Paths are not IDs. */
export function readPiSessionId(ctx: { sessionManager?: { getSessionId?(): unknown } }): string | undefined {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}
