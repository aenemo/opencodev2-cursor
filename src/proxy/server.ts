import http from "node:http"
import { randomBytes } from "node:crypto"
import type { AuthMaterial, BackendEvent, CursorBackend, CursorModel } from "../backends/types.js"
import { chooseBackend, parseBackendChoice } from "../backends/select.js"
import { chunk, prepareTurn, sse, type ChatRequest } from "./translate.js"
import { isTitleRequest, localTitle } from "./title.js"
import { resolveCursorModel } from "../backends/auto-models.js"
import { log } from "../util/log.js"

export interface ProxyDeps {
  getAuth: () => Promise<AuthMaterial | undefined>
  backends: Record<"cli" | "sdk" | "native", CursorBackend>
  fallbackDirectory: () => string
  models: () => Array<Pick<CursorModel, "id">>
  /** Map an OpenCode model id and selected variant to the Cursor id to run. */
  selectModel?: (model: string, variant?: string, cursorModel?: string) => string
  /** Quiet time with no sign the run is still going, before the turn fails. Default 5 minutes. A live SDK run reports in, so model silence waits for the turn cap. */
  idleTimeoutMs?: number
  /** Longest a single turn may run. Default 15 minutes. */
  turnTimeoutMs?: number
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === "string" && value ? value : undefined
}

export interface RunningProxy {
  port: number
  token: string
  close: () => Promise<void>
}

/** OpenCode sends the Cursor integration credential as Authorization, not the proxy token. The proxy only listens on loopback, so a local caller is allowed. */
export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    req.on("end", () => resolve(Buffer.concat(chunks).toString()))
    req.on("error", reject)
  })
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000

function abortText(signal: AbortSignal): string {
  const reason = signal.reason
  if (typeof reason === "string" && reason) return reason
  if (reason instanceof Error && reason.message) return reason.message
  return "Client aborted the Cursor turn"
}

/** Resolves on the next backend event, or as soon as the caller aborts. A silent worker cannot hold the response open. */
function nextChunk<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T> | "abort"> {
  if (signal.aborted) return Promise.resolve("abort")
  return new Promise((resolve) => {
    const onAbort = () => resolve("abort")
    signal.addEventListener("abort", onAbort, { once: true })
    iterator.next().then(
      (result) => {
        signal.removeEventListener("abort", onAbort)
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        resolve({ done: true, value: undefined as T })
        log("warn", "backend stream failed", error instanceof Error ? error.message : error)
      },
    )
  })
}

async function closeIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  try {
    await iterator.return?.()
  } catch {
    // The generator may already have finished.
  }
}

async function collect(events: AsyncIterable<BackendEvent>, signal: AbortSignal, onActivity?: () => void): Promise<BackendEvent[]> {
  const collected: BackendEvent[] = []
  const iterator = events[Symbol.asyncIterator]()
  let aborted = false
  for (;;) {
    const next = await nextChunk(iterator, signal)
    if (next === "abort") {
      aborted = true
      collected.push({ type: "error", message: abortText(signal) })
      break
    }
    if (next.done) break
    collected.push(next.value)
    onActivity?.()
    if (next.value.type === "tool_call" || next.value.type === "done" || next.value.type === "error") break
  }
  // The generator is paused on its last yield. Close it so its finally runs. Skip this after
  // an abort, because the underlying next() may still be pending.
  if (!aborted) await closeIterator(iterator)
  return collected
}

function writeJson(res: http.ServerResponse, model: string, id: string, events: BackendEvent[]): void {
  const text = events.filter((event) => event.type === "text").map((event) => event.text).join("")
  const toolCalls = events.filter((event) => event.type === "tool_call")
  const error = events.find((event) => event.type === "error")
  res.setHeader("content-type", "application/json")
  if (error && !text && toolCalls.length === 0) {
    res.writeHead(502)
    res.end(JSON.stringify({ error: { message: error.message } }))
    return
  }
  res.end(JSON.stringify({
    id,
    object: "chat.completion",
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.map((event) => event.type === "tool_call" ? {
          id: event.id,
          type: "function",
          function: { name: event.name, arguments: event.arguments },
        } : undefined),
      },
      finish_reason: toolCalls.length ? "tool_calls" : "stop",
    }],
  }))
}

async function streamSse(
  res: http.ServerResponse,
  model: string,
  id: string,
  events: AsyncIterable<BackendEvent>,
  signal: AbortSignal,
  timing?: { started: number; label: string },
  onActivity?: () => void,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  res.flushHeaders()
  let started = false
  let toolIndex = 0
  let firstTokenAt: number | undefined
  let wroteError = false
  let aborted = false
  const iterator = events[Symbol.asyncIterator]()
  for (;;) {
    const next = await nextChunk(iterator, signal)
    if (next === "abort") {
      aborted = true
      break
    }
    if (next.done) break
    const event = next.value
    onActivity?.()
    if (event.type === "text") {
      firstTokenAt ??= Date.now()
      res.write(sse(chunk(model, id, { role: started ? undefined : "assistant", content: event.text }, null)))
      started = true
    } else if (event.type === "reasoning") {
      firstTokenAt ??= Date.now()
      res.write(sse(chunk(model, id, { reasoning_content: event.text }, null)))
    } else if (event.type === "tool_call") {
      firstTokenAt ??= Date.now()
      res.write(sse(chunk(model, id, {
        tool_calls: [{ index: toolIndex, id: event.id, type: "function", function: { name: event.name, arguments: event.arguments } }],
      }, null)))
      toolIndex += 1
      break
    } else if (event.type === "keepalive") {
      // Activity only. The Cursor run is still open, and this is not model output.
    } else if (event.type === "error") {
      res.write(sse({ error: { message: event.message } }))
      wroteError = true
      break
    } else if (event.type === "done") {
      break
    }
  }
  if (aborted && !wroteError) res.write(sse({ error: { message: abortText(signal) } }))
  if (!aborted) await closeIterator(iterator)
  if (timing) {
    log("info", "proxy timing", {
      label: timing.label,
      model,
      ttftMs: firstTokenAt ? firstTokenAt - timing.started : undefined,
      totalMs: Date.now() - timing.started,
    })
  }
  res.write(sse(chunk(model, id, {}, toolIndex > 0 ? "tool_calls" : "stop")))
  res.write("data: [DONE]\n\n")
  res.end()
}

async function* titleEvents(text: string): AsyncIterable<BackendEvent> {
  yield { type: "text", text }
  yield { type: "done", text }
}

const attached: ProxyDeps[] = []
let shared: Promise<RunningProxy> | undefined
let users = 0

function currentDeps(): ProxyDeps {
  const deps = attached[attached.length - 1]
  if (!deps) throw new Error("Cursor proxy has no active plugin instance")
  return deps
}

/** One proxy per process. Each OpenCode project registers its own auth and backends; requests use the latest one still attached. */
export async function startSharedProxy(deps: ProxyDeps): Promise<RunningProxy> {
  attached.push(deps)
  shared ??= startProxy(currentDeps)
  const proxy = await shared
  users += 1
  let closed = false
  return {
    port: proxy.port,
    token: proxy.token,
    close: async () => {
      if (closed) return
      closed = true
      const index = attached.lastIndexOf(deps)
      if (index >= 0) attached.splice(index, 1)
      users -= 1
      if (users === 0) {
        shared = undefined
        attached.length = 0
        await proxy.close()
      }
    },
  }
}

export function startProxy(depsOrGet: ProxyDeps | (() => ProxyDeps)): Promise<RunningProxy> {
  const getDeps = typeof depsOrGet === "function" ? depsOrGet : () => depsOrGet
  const token = randomBytes(24).toString("base64url")
  const server = http.createServer(async (req, res) => {
    try {
      const deps = getDeps()
      const url = new URL(req.url || "/", "http://127.0.0.1")
      if (!isLoopback(req.socket.remoteAddress) && (req.headers.authorization || "") !== `Bearer ${token}`) {
        res.writeHead(401, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "unauthorized" } }))
        return
      }
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/models")) {
        if (url.pathname === "/v1/models") {
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify({
            object: "list",
            data: deps.models().map((model) => ({ id: model.id, object: "model", owned_by: "cursor" })),
          }))
          return
        }
        res.end("ok")
        return
      }
      if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        res.writeHead(404)
        res.end()
        return
      }
      const requestStarted = Date.now()
      const body = JSON.parse(await readBody(req)) as ChatRequest
      const turn = prepareTurn(body)
      const selected = deps.selectModel?.(
        turn.model,
        header(req, "x-opencodev2-cursor-variant"),
        header(req, "x-opencodev2-cursor-model"),
      ) ?? turn.model
      const resolved = resolveCursorModel(selected)
      const model = turn.model
      const id = `chatcmpl-${randomBytes(8).toString("hex")}`
      if (isTitleRequest(turn)) {
        const title = localTitle(turn.lastUserPrompt)
        log("info", "local session title", { title, ms: Date.now() - requestStarted })
        if (body.stream === false) writeJson(res, model, id, [
          { type: "text", text: title },
          { type: "done", text: title },
        ])
        else await streamSse(res, model, id, titleEvents(title), new AbortController().signal, {
          started: requestStarted,
          label: "title-local",
        })
        return
      }
      const auth = await deps.getAuth()
      const choice = chooseBackend(parseBackendChoice(process.env.CURSOR_BACKEND), auth)
      const backend = deps.backends[choice]
      const encodedDir = req.headers["x-opencode-directory"]
      const cwd = typeof encodedDir === "string" && encodedDir ? decodeURIComponent(encodedDir) : deps.fallbackDirectory()
      const sessionHeader = req.headers["x-opencodev2-cursor-session"]
      const sessionKey = typeof sessionHeader === "string" && sessionHeader ? sessionHeader : "default"
      const controller = new AbortController()
      const idleMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
      const turnMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
      const abortWith = (message: string) => {
        if (!controller.signal.aborted) controller.abort(new Error(message))
      }
      let idleTimer: NodeJS.Timeout | undefined
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => abortWith(`No Cursor output for ${Math.round(idleMs / 1000)} seconds`), idleMs)
      }
      armIdle()
      const turnTimer = setTimeout(() => abortWith(`Cursor turn timed out after ${Math.round(turnMs / 60000)} minutes`), turnMs)
      const onClientGone = () => {
        if (!res.writableEnded) abortWith("Client aborted the Cursor turn")
      }
      res.on("close", onClientGone)
      req.on("aborted", () => abortWith("Client aborted the Cursor turn"))
      const stream = backend.run({
        model: resolved.cursorId,
        modelParams: resolved.params,
        cliModel: resolved.cliModel,
        prompt: turn.prompt,
        lastUserPrompt: turn.lastUserPrompt,
        cwd,
        tools: turn.tools,
        toolResults: turn.toolResults,
        continuation: turn.continuation,
        sessionKey,
        signal: controller.signal,
      })
      try {
        if (body.stream === false) {
          const events = await collect(stream, controller.signal, armIdle)
          log("info", "proxy timing", {
            label: "chat-json",
            model: resolved.cliModel,
            totalMs: Date.now() - requestStarted,
          })
          writeJson(res, model, id, events)
        } else {
          await streamSse(res, model, id, stream, controller.signal, {
            started: requestStarted,
            label: "chat",
          }, armIdle)
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
        clearTimeout(turnTimer)
        res.removeListener("close", onClientGone)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cursor request failed"
      log("error", "proxy request failed", message)
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message } }))
      } else res.end()
    }
  })

  return new Promise((resolve, reject) => {
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Proxy failed to bind"))
        return
      }
      log("info", "proxy listening", { port: address.port })
      resolve({
        port: address.port,
        token,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}
