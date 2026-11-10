import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { SdkBackend } from "./sdk.js"
import type { BackendEvent, BackendRunRequest } from "./types.js"

interface RunnerEvent {
  type: string
  id?: string
  requestId?: string
  sessionKey?: string
  text?: string
  message?: string
  name?: string
  arguments?: string
  agentId?: string
  models?: Array<{ id: string; name: string; variants?: [] }>
}

class ScriptedRunner {
  alive = true
  modelCalls = 0
  private lanes = new Map<string, { events: RunnerEvent[]; waiters: Array<(event: RunnerEvent) => void> }>()
  private closed = new Set<string>()

  constructor(private readonly hooks: {
    onTurn?: (cmd: Record<string, string>, push: (event: RunnerEvent) => void) => void
    onTool?: (cmd: Record<string, string>, push: (event: RunnerEvent) => void) => void
    rateLimit?: boolean
  } = {}) {}

  private bucket(key: string) {
    let lane = this.lanes.get(key)
    if (!lane) {
      lane = { events: [], waiters: [] }
      this.lanes.set(key, lane)
    }
    return lane
  }

  push(key: string, event: RunnerEvent): void {
    if (!key || this.closed.has(key)) return
    const lane = this.bucket(key)
    const waiter = lane.waiters.shift()
    if (waiter) waiter(event)
    else lane.events.push(event)
  }

  send(message: unknown): void {
    const cmd = message as Record<string, string>
    const key = cmd.requestId || cmd.id
    const push = (event: RunnerEvent) => this.push(key, event)
    if (cmd.type === "prewarm") {
      push({ type: "warm", id: cmd.id })
      return
    }
    if (cmd.type === "models") {
      this.modelCalls += 1
      if (this.hooks.rateLimit) {
        push({ type: "error", id: cmd.id, message: "exceeded the rate limit of 30 requests per minute for the get_models endpoint" })
      } else {
        push({ type: "models", id: cmd.id, models: [{ id: "grok-4.7", name: "Grok 4.7", variants: [] }] })
      }
      return
    }
    if (cmd.type === "turn") this.hooks.onTurn?.(cmd, push)
    if (cmd.type === "tool_result") this.hooks.onTool?.(cmd, push)
    if (cmd.type === "cancel") push({ type: "error", message: "Cursor run was cancelled", requestId: cmd.requestId })
  }

  next(lane: string): Promise<RunnerEvent> {
    const bucket = this.bucket(lane)
    const queued = bucket.events.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve) => bucket.waiters.push(resolve))
  }

  discard(lane: string): void {
    this.closed.add(lane)
    this.lanes.delete(lane)
  }

  kill(): void {
    this.alive = false
  }
}

function request(sessionKey: string, extra: Partial<BackendRunRequest> = {}): BackendRunRequest {
  return {
    model: "grok-4.7",
    prompt: "hi",
    cwd: process.cwd(),
    tools: [],
    sessionKey,
    signal: new AbortController().signal,
    ...extra,
  }
}

async function collect(events: AsyncIterable<BackendEvent>): Promise<BackendEvent[]> {
  const received: BackendEvent[] = []
  for await (const event of events) received.push(event)
  return received
}

describe("sdk backend sessions", () => {
  beforeEach(() => {
    process.env.OPENCODEV2_CURSOR_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "opencodev2-cursor-sdk-"))
  })

  it("lets a second session finish while the first is paused on a tool call", async () => {
    let releaseFirst!: () => void
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const runner = new ScriptedRunner({
      onTurn(cmd, push) {
        if (cmd.sessionKey === "session-a") {
          void hold.then(() => {
            push({ type: "session", agentId: "agent-a", requestId: cmd.requestId, sessionKey: "session-a" })
            push({ type: "tool", id: "tool-1", name: "glob", arguments: "{}", requestId: cmd.requestId })
          })
          return
        }
        push({ type: "done", text: "b done", requestId: cmd.requestId })
      },
      onTool(cmd, push) {
        push({ type: "done", text: "a done", requestId: cmd.requestId })
      },
    })
    const backend = new SdkBackend(async () => "test-key", {
      connect: () => runner,
      idleTimeoutMs: 5_000,
      turnTimeoutMs: 20_000,
    })
    const first = collect(backend.run(request("session-a")))
    const second = await collect(backend.run(request("session-b")))
    expect(second.at(-1)).toEqual({ type: "done", text: "b done" })
    releaseFirst()
    const paused = await first
    expect(paused.some((event) => event.type === "tool_call" && event.id === "tool-1")).toBe(true)
    const resumed = await collect(backend.run(request("session-a", {
      continuation: true,
      toolResults: [{ id: "tool-1", content: "files" }],
    })))
    expect(resumed.at(-1)).toEqual({ type: "done", text: "a done" })
  })

  it("lets the next turn start when the caller stops reading after a tool call", async () => {
    let turns = 0
    const runner = new ScriptedRunner({
      onTurn(cmd, push) {
        turns += 1
        push({ type: "tool", id: "tool-1", name: "glob", arguments: "{}", requestId: cmd.requestId })
      },
    })
    const backend = new SdkBackend(async () => "test-key", {
      connect: () => runner,
      idleTimeoutMs: 5_000,
      turnTimeoutMs: 20_000,
    })
    const iterator = backend.run(request("session-a"))[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value?.type).toBe("tool_call")
    const started = Date.now()
    await collect(backend.run(request("session-a")))
    expect(Date.now() - started).toBeLessThan(500)
    expect(turns).toBe(2)
  })

  it("continues on a new run when a tool result arrives after the paused run has ended", async () => {
    let turns = 0
    let recoveryPrompt = ""
    const runner = new ScriptedRunner({
      onTurn(cmd, push) {
        turns += 1
        if (turns === 1) {
          push({ type: "session", agentId: "agent-a", requestId: cmd.requestId })
          push({ type: "done", text: "first", requestId: cmd.requestId })
          return
        }
        recoveryPrompt = cmd.prompt
        push({ type: "done", text: "recovered", requestId: cmd.requestId })
      },
      onTool(cmd, push) {
        push({ type: "error", requestId: cmd.requestId, message: "Tool result arrived after the Cursor run ended" })
      },
    })
    const backend = new SdkBackend(async () => "test-key", {
      connect: () => runner,
      idleTimeoutMs: 5_000,
      turnTimeoutMs: 20_000,
    })
    await collect(backend.run(request("session-a")))
    const started = Date.now()
    const orphan = await collect(backend.run(request("session-a", {
      continuation: true,
      prompt: "User:\nlook at the files",
      toolResults: [{ id: "gone", content: "late tool output" }],
    })))
    expect(Date.now() - started).toBeLessThan(500)
    expect(recoveryPrompt).toContain("late tool output")
    expect(orphan.at(-1)).toEqual({ type: "done", text: "recovered" })
    expect(turns).toBe(2)
  })

  it("releases the session lock when a turn goes idle", async () => {
    const sent: number[] = []
    const runner = new ScriptedRunner({
      onTurn(cmd, push) {
        sent.push(Date.now())
        if (sent.length === 1) return
        push({ type: "done", text: "second", requestId: cmd.requestId })
      },
    })
    const backend = new SdkBackend(async () => "test-key", {
      connect: () => runner,
      idleTimeoutMs: 40,
      turnTimeoutMs: 5_000,
    })
    const first = collect(backend.run(request("same")))
    const second = collect(backend.run(request("same")))
    const [firstEvents, secondEvents] = await Promise.all([first, second])
    expect(firstEvents.at(-1)?.type).toBe("error")
    expect(secondEvents.at(-1)).toEqual({ type: "done", text: "second" })
    expect(sent).toHaveLength(2)
    expect(sent[1]! - sent[0]!).toBeGreaterThanOrEqual(30)
    expect(sent[1]! - sent[0]!).toBeLessThan(1_000)
  })

  it("fails the pending turn when the worker crashes, then respawns it", async () => {
    let workers = 0
    const backend = new SdkBackend(async () => "test-key", {
      connect: () => {
        workers += 1
        const crash = workers === 1
        const runner = new ScriptedRunner({
          onTurn(cmd, push) {
            if (crash) {
              runner.alive = false
              push({ type: "error", message: "Cursor SDK runner exited (signal)", requestId: cmd.requestId })
              return
            }
            push({ type: "done", text: "respawned", requestId: cmd.requestId })
          },
        })
        return runner
      },
      idleTimeoutMs: 2_000,
      turnTimeoutMs: 10_000,
    })
    const failed = await collect(backend.run(request("session-a")))
    expect(failed.at(-1)).toEqual({ type: "error", message: "Cursor SDK runner exited (signal)" })
    const next = await collect(backend.run(request("session-a")))
    expect(next.at(-1)).toEqual({ type: "done", text: "respawned" })
    expect(workers).toBe(2)
  })
})
