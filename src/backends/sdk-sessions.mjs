/**
 * One worker process, one agent and run per OpenCode session.
 * A new turn cancels only its own session, so a paused tool call in another session stays waiting.
 */

export function createSessionHub() {
  const sessions = new Map()

  function ensure(key) {
    const sessionKey = key || "default"
    let session = sessions.get(sessionKey)
    if (!session) {
      session = {
        sessionKey,
        agent: null,
        modelKey: null,
        run: null,
        waiters: new Map(),
        busy: false,
        generation: 0,
        requestId: undefined,
      }
      sessions.set(sessionKey, session)
    }
    return session
  }

  async function clear(session, reason) {
    session.generation += 1
    const requestId = session.requestId
    const pending = session.run
    session.run = null
    for (const resolve of session.waiters.values()) resolve("(cancelled)")
    session.waiters.clear()
    if (pending) {
      try {
        await pending.cancel()
      } catch {
        // Already finished, or the store already marked it cancelled.
      }
    }
    session.busy = false
    return { reason, sessionKey: session.sessionKey, requestId }
  }

  return {
    ensure,
    has(key) {
      return sessions.has(key || "default")
    },
    clear,
    toolResult(cmd) {
      const sessionKey = cmd.sessionKey || "default"
      const session = sessions.get(sessionKey)
      const resolve = session?.waiters.get(cmd.id)
      if (!session || !resolve) {
        return {
          ok: false,
          sessionKey,
          requestId: cmd.requestId,
          message: "Tool result arrived after the Cursor run ended",
        }
      }
      if (cmd.requestId) session.requestId = cmd.requestId
      session.waiters.delete(cmd.id)
      resolve(cmd.content ?? "")
      return { ok: true, sessionKey, requestId: session.requestId }
    },
    async cancel(sessionKey, reason) {
      const why = reason || "cancel"
      if (!sessionKey) {
        const cleared = []
        for (const session of sessions.values()) cleared.push(await clear(session, why))
        return { cancelled: cleared.length > 0, cleared }
      }
      const session = sessions.get(sessionKey)
      if (!session || (!session.busy && !session.run && session.waiters.size === 0)) {
        return { cancelled: false, sessionKey, reason: why, requestId: session?.requestId }
      }
      const cleared = await clear(session, why)
      return { cancelled: true, ...cleared }
    },
  }
}
