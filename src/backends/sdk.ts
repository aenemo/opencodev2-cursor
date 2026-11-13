import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { BackendEvent, BackendRunRequest, CursorBackend, CursorModel } from "./types.js"
import { FALLBACK_MODELS, MODEL_CONTEXT_WINDOW, MODEL_MAX_TOKENS, promptWithToolResults } from "./types.js"
import { expandSdkModels, type SdkListedModel } from "./sdk-models.js"
import { assertNodeForSdk, nodeBinary } from "./spawn.js"
import { modelSelectionKey } from "./auto-models.js"
import { cacheDir, compileCacheDir, sdkStateDir } from "../util/paths.js"
import { readCheckpoint, writeCheckpoint } from "./checkpoint.js"
import { log } from "../util/log.js"
import { mapCursorTool } from "../proxy/tools.js"
import { createModelCache, type ModelCache } from "./model-cache.js"

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000
export const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000
/** The runner sends this when a tool result has no paused run. The parent starts a fresh turn instead of failing the chat. */
export const ORPHAN_TOOL_RESULT = "Tool result arrived after the Cursor run ended"

interface RunnerEvent {
  type: string
  id?: string
  requestId?: string
  sessionKey?: string
  name?: string
  text?: string
  message?: string
  arguments?: string
  agentId?: string
  models?: SdkListedModel[]
  ms?: number
  cwd?: string
  prewarmed?: boolean
  event?: string
  reason?: string
  toolId?: string
  model?: string
}

interface RunnerTransport {
  readonly alive: boolean
  send(message: unknown): void
  next(lane: string): Promise<RunnerEvent>
  discard(lane: string): void
  kill(): void
}

interface Lane {
  events: RunnerEvent[]
  waiters: Array<(event: RunnerEvent) => void>
}

class SdkRunner implements RunnerTransport {
  private lanes = new Map<string, Lane>()
  private closed = new Set<string>()
  private dead: RunnerEvent | undefined
  private socket: net.Socket
  agentId: string | undefined
  alive = true

  constructor(socket: net.Socket) {
    this.socket = socket
    const lines = createInterface({ input: socket })
    lines.on("line", (line) => {
      let event: RunnerEvent
      try {
        event = JSON.parse(line) as RunnerEvent
      } catch {
        return
      }
      if (event.type === "diag") {
        log("info", event.event || "sdk", {
          sessionKey: event.sessionKey,
          model: event.model,
          reason: event.reason,
          toolId: event.toolId,
        })
        return
      }
      if (event.type === "session" && event.agentId) this.agentId = event.agentId
      if (event.type === "warn" && event.message) log("warn", "sdk runner", event.message)
      if (event.type === "idle" || event.type === "pong" || event.type === "warn") return
      this.deliver(event)
    })
    socket.on("error", () => socket.destroy())
    socket.on("close", () => {
      this.failAll("Cursor SDK runner exited (closed)")
    })
  }

  private laneKey(event: RunnerEvent): string {
    if (event.requestId) return event.requestId
    if (event.id) return event.id
    if (event.sessionKey) return event.sessionKey
    return "default"
  }

  private lane(key: string): Lane {
    let found = this.lanes.get(key)
    if (!found) {
      found = { events: [], waiters: [] }
      this.lanes.set(key, found)
    }
    return found
  }

  private deliver(event: RunnerEvent): void {
    if (this.dead) return
    const key = this.laneKey(event)
    if (this.closed.has(key)) return
    const bucket = this.lane(key)
    const waiter = bucket.waiters.shift()
    if (waiter) waiter(event)
    else bucket.events.push(event)
  }

  private failAll(message: string): void {
    if (this.dead) return
    this.alive = false
    this.dead = { type: "error", message }
    for (const bucket of this.lanes.values()) {
      if (bucket.waiters.length === 0) bucket.events.push({ ...this.dead })
      while (bucket.waiters.length > 0) bucket.waiters.shift()?.({ ...this.dead })
    }
  }

  send(message: unknown): void {
    this.socket.write(JSON.stringify(message) + "\n")
  }

  next(laneKey: string): Promise<RunnerEvent> {
    if (this.dead) return Promise.resolve({ ...this.dead })
    const bucket = this.lane(laneKey)
    const queued = bucket.events.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve) => bucket.waiters.push(resolve))
  }

  discard(laneKey: string): void {
    this.closed.add(laneKey)
    this.lanes.delete(laneKey)
  }

  kill(): void {
    this.alive = false
    try {
      this.socket.end()
    } catch {
      // The socket may already be gone.
    }
  }
}

function stampModels(models: SdkListedModel[]): CursorModel[] {
  return expandSdkModels(models).map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: MODEL_CONTEXT_WINDOW,
    maxTokens: MODEL_MAX_TOKENS,
    ...(model.isDefault ? { isDefault: true } : {}),
  }))
}

function runnerScript(): string {
  return fileURLToPath(new URL("./sdk-runner.mjs", import.meta.url))
}

function brokerScript(): string {
  return fileURLToPath(new URL("./sdk-broker.mjs", import.meta.url))
}

function readBrokerInfo(): { port: number; pid: number } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cacheDir(), "sdk-broker.json"), "utf8")) as { port?: number; pid?: number }
    if (!parsed.port || !parsed.pid) return undefined
    return { port: parsed.port, pid: parsed.pid }
  } catch {
    return undefined
  }
}

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1")
    const finish = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

let brokerSpawned = false

function spawnBroker(): void {
  if (brokerSpawned) return
  brokerSpawned = true
  const child = spawn(nodeBinary(), [brokerScript(), cacheDir(), runnerScript()], {
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, NODE_COMPILE_CACHE: compileCacheDir() },
  })
  child.on("exit", () => {
    brokerSpawned = false
  })
}

function socketReady(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve())
    socket.once("error", reject)
  })
}

async function connectSharedRunner(): Promise<RunnerTransport> {
  if (!process.env.CURSOR_ACP_NODE_BIN) assertNodeForSdk()
  fs.mkdirSync(cacheDir(), { recursive: true })
  for (let attempt = 0; attempt < 40; attempt++) {
    const info = readBrokerInfo()
    if (info && await probe(info.port)) {
      const socket = net.connect(info.port, "127.0.0.1")
      socket.setNoDelay(true)
      try {
        await socketReady(socket)
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
        continue
      }
      log("info", "sdk worker connected", { pid: info.pid })
      return new SdkRunner(socket)
    }
    spawnBroker()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("Cursor SDK worker did not start")
}

function signalMessage(signal: AbortSignal): string {
  const reason = signal.reason
  if (typeof reason === "string" && reason) return reason
  if (reason instanceof Error && reason.message) return reason.message
  return "Client aborted the Cursor turn"
}

function isTimeoutMessage(message: string): boolean {
  return message.startsWith("No Cursor output") || message.startsWith("Cursor turn timed out")
}

export interface RememberedAgent {
  agentId: string
  modelKey: string
}

export interface SdkBackendOptions {
  idleTimeoutMs?: number
  turnTimeoutMs?: number
  modelsCacheTtlMs?: number
  /** Test hook. The default connects to the shared SDK worker. */
  connect?: () => RunnerTransport | Promise<RunnerTransport>
}

/** Resume only when the stored agent was created for this model and its params. */
export function resumeAgentId(
  model: string,
  modelParams: Array<{ id: string; value: string }> | undefined,
  live: RememberedAgent | undefined,
  saved: { agentId: string; model: string } | undefined,
): string | undefined {
  const modelKey = modelSelectionKey(model, modelParams)
  if (live?.modelKey === modelKey) return live.agentId
  if (!saved) return undefined
  if (saved.model === modelKey) return saved.agentId
  // Checkpoints written before selection keys stored the plain Cursor id.
  // Auto Router always has params, so an old "auto-smart" id is not enough to resume a Cost or Intelligence turn.
  if (saved.model === model && !(modelParams?.length)) return saved.agentId
  return undefined
}

/**
 * One shared SDK worker for every project on this machine, with a separate agent, run, and lock per OpenCode session.
 * A turn in one session cannot cancel a run that another session has paused on a tool call.
 */
export class SdkBackend implements CursorBackend {
  readonly id = "sdk" as const
  private runner: RunnerTransport | undefined
  private connecting: Promise<RunnerTransport> | undefined
  private sessionAgents = new Map<string, RememberedAgent>()
  private sessionLocks = new Map<string, Promise<void>>()
  private prewarms = new Map<string, Promise<void>>()
  private readonly models: ModelCache
  private readonly connect: () => RunnerTransport | Promise<RunnerTransport>
  private readonly idleTimeoutMs: number
  private readonly turnTimeoutMs: number

  constructor(private readonly apiKey: () => Promise<string>, options?: SdkBackendOptions) {
    this.connect = options?.connect ?? connectSharedRunner
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.turnTimeoutMs = options?.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    this.models = createModelCache({ ttlMs: options?.modelsCacheTtlMs })
  }

  private async ensureRunner(): Promise<RunnerTransport> {
    if (this.runner?.alive) return this.runner
    if (!this.connecting) {
      this.prewarms.clear()
      this.connecting = Promise.resolve().then(() => this.connect()).then((runner) => {
        this.runner = runner
        return runner
      })
    }
    try {
      return await this.connecting
    } finally {
      this.connecting = undefined
    }
  }

  private async prewarm(cwd: string): Promise<void> {
    const existing = this.prewarms.get(cwd)
    if (existing) return existing
    const flight = this.sendPrewarm(cwd)
    this.prewarms.set(cwd, flight)
    try {
      await flight
    } catch (error) {
      this.prewarms.delete(cwd)
      throw error
    }
  }

  private async sendPrewarm(cwd: string): Promise<void> {
    const apiKey = await this.apiKey()
    const runner = await this.ensureRunner()
    const id = `prewarm:${randomUUID()}`
    runner.send({ type: "prewarm", id, apiKey, cwd, stateRoot: sdkStateDir(cwd) })
    const event = await runner.next(id)
    runner.discard(id)
    if (event.type === "error") throw new Error(event.message || "SDK prewarm failed")
  }

  private async requestModels(cwd: string): Promise<CursorModel[]> {
    const apiKey = await this.apiKey()
    const runner = await this.ensureRunner()
    const id = `models:${randomUUID()}`
    runner.send({ type: "models", id, apiKey, cwd, stateRoot: cwd ? sdkStateDir(cwd) : undefined })
    const event = await runner.next(id)
    runner.discard(id)
    if (event.type === "error") throw new Error(event.message || "SDK model list failed")
    const models = stampModels(event.models ?? [])
    return models.length > 0 ? models : FALLBACK_MODELS
  }

  async warmUp(cwd: string): Promise<CursorModel[]> {
    try {
      await this.prewarm(cwd)
    } catch (error) {
      log("warn", "sdk prewarm failed", error instanceof Error ? error.message : error)
    }
    return this.models.load(() => this.requestModels(cwd))
  }

  async listModels(): Promise<CursorModel[]> {
    return this.models.load(() => this.requestModels(""))
  }

  async *run(request: BackendRunRequest): AsyncIterable<BackendEvent> {
    const key = request.sessionKey || "default"
    let release!: () => void
    const previous = this.sessionLocks.get(key) ?? Promise.resolve()
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.sessionLocks.set(key, gate)
    let released = false
    const releaseOnce = () => {
      if (released) return
      released = true
      release()
    }
    let onQueuedAbort: (() => void) | undefined
    try {
      if (request.signal.aborted) return
      const aborted = new Promise<"abort">((resolve) => {
        onQueuedAbort = () => resolve("abort")
        request.signal.addEventListener("abort", onQueuedAbort, { once: true })
      })
      const waited = await Promise.race([previous.then(() => "ready" as const), aborted])
      request.signal.removeEventListener("abort", onQueuedAbort!)
      if (waited === "abort" || request.signal.aborted) {
        log("info", "client abort", {
          sessionKey: request.sessionKey,
          model: request.model,
          reason: "queued behind another turn",
        })
        return
      }
      const turnStarted = Date.now()
      // Release before yielding a terminal event. The caller stops reading there, so code
      // after that yield, including finally, would not run and the next turn would wait forever.
      for await (const event of this.runLocked(request, turnStarted)) {
        if (event.type === "tool_call" || event.type === "done" || event.type === "error") releaseOnce()
        yield event
      }
    } finally {
      if (onQueuedAbort) request.signal.removeEventListener("abort", onQueuedAbort)
      releaseOnce()
    }
  }

  private async nextEvent(
    runner: RunnerTransport,
    lane: string,
    signal: AbortSignal,
    deadline: number,
  ): Promise<RunnerEvent | "abort" | "idle" | "overall"> {
    if (signal.aborted) return "abort"
    const overallLeft = deadline - Date.now()
    if (overallLeft <= 0) return "overall"
    const idleLimited = overallLeft > this.idleTimeoutMs
    const waitMs = idleLimited ? this.idleTimeoutMs : overallLeft
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<"idle" | "overall">((resolve) => {
      timer = setTimeout(() => resolve(idleLimited ? "idle" : "overall"), waitMs)
    })
    let onAbort!: () => void
    const aborted = new Promise<"abort">((resolve) => {
      onAbort = () => resolve("abort")
      signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      return await Promise.race([runner.next(lane), timeout, aborted])
    } finally {
      if (timer) clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
    }
  }

  private cancelRun(runner: RunnerTransport, request: BackendRunRequest, requestId: string, reason: string): void {
    log("info", isTimeoutMessage(reason) ? "timeout" : "client abort", {
      sessionKey: request.sessionKey,
      model: request.model,
      reason,
    })
    log("info", "run cancelled", { sessionKey: request.sessionKey, model: request.model, reason })
    try {
      runner.send({ type: "cancel", sessionKey: request.sessionKey, requestId, reason, model: request.model })
    } catch {
      // The worker is already gone.
    }
  }

  private async *runLocked(request: BackendRunRequest, turnStarted: number): AsyncIterable<BackendEvent> {
    const requestId = randomUUID()
    const deadline = turnStarted + this.turnTimeoutMs
    log("info", "turn start", { sessionKey: request.sessionKey, model: request.model, requestId })
    let runner: RunnerTransport | undefined
    try {
      runner = await this.ensureRunner()
      const apiKey = await this.apiKey()
      const advertised = new Set(request.tools.map((tool) => tool.name))
      const hostTools = request.tools.filter((tool) => mapCursorTool(tool.name, advertised))
      const saved = readCheckpoint(request.sessionKey)
      const resumeId = resumeAgentId(request.model, request.modelParams, this.sessionAgents.get(request.sessionKey), saved)
      const promptToSend = resumeId && request.lastUserPrompt ? request.lastUserPrompt : request.prompt
      const dispatchAt = Date.now()

      if (request.continuation && resumeId && request.toolResults?.length) {
        for (const result of request.toolResults) {
          log("info", "tool result received", { sessionKey: request.sessionKey, model: request.model, toolId: result.id })
          runner.send({
            type: "tool_result",
            id: result.id,
            content: result.content,
            sessionKey: request.sessionKey,
            requestId,
            model: request.model,
          })
        }
      } else {
        runner.send({
          type: "turn",
          requestId,
          apiKey,
          model: request.model,
          modelParams: request.modelParams,
          cwd: request.cwd,
          stateRoot: sdkStateDir(request.cwd),
          prompt: promptToSend,
          tools: hostTools,
          agentId: resumeId,
          sessionKey: request.sessionKey,
          idleTimeoutMs: this.idleTimeoutMs,
        })
      }

      let firstTokenAt: number | undefined
      let recoveredOrphan = false
      for (;;) {
        const event = await this.nextEvent(runner, requestId, request.signal, deadline)
        if (event === "abort" || event === "idle" || event === "overall") {
          const reason = event === "abort"
            ? signalMessage(request.signal)
            : event === "overall"
              ? `Cursor turn timed out after ${Math.round(this.turnTimeoutMs / 60000)} minutes`
              : `No Cursor output for ${Math.round(this.idleTimeoutMs / 1000)} seconds`
          this.cancelRun(runner, request, requestId, reason)
          this.logTiming(request, turnStarted, dispatchAt, firstTokenAt, event === "abort" ? "abort" : "timeout")
          yield { type: "error", message: reason }
          return
        }
        if (event.type === "text" && event.text) {
          firstTokenAt ??= Date.now()
          yield { type: "text", text: event.text }
        } else if (event.type === "reasoning" && event.text) {
          firstTokenAt ??= Date.now()
          yield { type: "reasoning", text: event.text }
        } else if (event.type === "tool") {
          firstTokenAt ??= Date.now()
          const name = mapCursorTool(event.name || "", advertised) || event.name || "tool"
          yield {
            type: "tool_call",
            id: event.id || "tool",
            name,
            arguments: event.arguments || "{}",
          }
          this.logTiming(request, turnStarted, dispatchAt, firstTokenAt, "tool")
          return
        } else if (event.type === "error") {
          if (!recoveredOrphan && event.message === ORPHAN_TOOL_RESULT && request.toolResults?.length) {
            recoveredOrphan = true
            log("info", "orphan tool result", {
              sessionKey: request.sessionKey,
              model: request.model,
              reason: "continuing on a new run",
            })
            runner.send({
              type: "turn",
              requestId,
              apiKey,
              model: request.model,
              modelParams: request.modelParams,
              cwd: request.cwd,
              stateRoot: sdkStateDir(request.cwd),
              prompt: promptWithToolResults(request.prompt, request.toolResults),
              tools: hostTools,
              sessionKey: request.sessionKey,
              idleTimeoutMs: this.idleTimeoutMs,
            })
            continue
          }
          this.logTiming(request, turnStarted, dispatchAt, firstTokenAt, "error")
          yield { type: "error", message: event.message || "Cursor SDK failed" }
          return
        } else if (event.type === "keepalive") {
          yield { type: "keepalive" }
        } else if (event.type === "done") {
          const agentId = event.agentId || this.sessionAgents.get(request.sessionKey)?.agentId
          if (agentId) {
            const modelKey = modelSelectionKey(request.model, request.modelParams)
            this.sessionAgents.set(request.sessionKey, { agentId, modelKey })
            writeCheckpoint(request.sessionKey, { agentId, model: modelKey })
          }
          this.logTiming(request, turnStarted, dispatchAt, firstTokenAt, "done")
          yield { type: "done", text: event.text }
          return
        } else if (event.type === "session" && event.agentId) {
          this.sessionAgents.set(request.sessionKey, {
            agentId: event.agentId,
            modelKey: modelSelectionKey(request.model, request.modelParams),
          })
        }
      }
    } finally {
      runner?.discard(requestId)
    }
  }

  private logTiming(
    request: BackendRunRequest,
    turnStarted: number,
    dispatchAt: number,
    firstTokenAt: number | undefined,
    outcome: string,
  ): void {
    const now = Date.now()
    log("info", "turn timing", {
      backend: "sdk",
      model: request.model,
      sessionKey: request.sessionKey,
      outcome,
      startupMs: dispatchAt - turnStarted,
      ttftMs: firstTokenAt ? firstTokenAt - turnStarted : undefined,
      totalMs: now - turnStarted,
      promptChars: request.prompt.length,
    })
  }

  async dispose(): Promise<void> {
    this.runner?.kill()
    this.runner = undefined
    this.sessionAgents.clear()
  }
}
