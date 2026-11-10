import { describe, expect, it } from "vitest"
import { createSessionHub } from "./sdk-sessions.mjs"

describe("session hub", () => {
  it("keeps another session's paused tool call when one session is cleared", async () => {
    const hub = createSessionHub()
    const first = hub.ensure("session-a")
    const second = hub.ensure("session-b")
    first.busy = true
    second.busy = true
    let resumed = ""
    first.waiters.set("tool-1", (content: string) => {
      resumed = content
    })
    await hub.clear(second, "new turn")
    expect(first.waiters.has("tool-1")).toBe(true)
    expect(second.busy).toBe(false)
    const delivered = hub.toolResult({ sessionKey: "session-a", id: "tool-1", content: "files", requestId: "later" })
    expect(delivered.ok).toBe(true)
    expect(resumed).toBe("files")
    expect(first.requestId).toBe("later")
  })

  it("replies immediately when a tool result has no waiting run", () => {
    const hub = createSessionHub()
    const started = Date.now()
    const result = hub.toolResult({ sessionKey: "missing", id: "tool-9", content: "late", requestId: "r9" })
    expect(Date.now() - started).toBeLessThan(50)
    expect(result).toMatchObject({
      ok: false,
      sessionKey: "missing",
      requestId: "r9",
      message: "Tool result arrived after the Cursor run ended",
    })
  })
})
