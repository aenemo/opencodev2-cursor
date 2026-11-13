import path from "node:path"
import readline from "node:readline"
import { randomUUID } from "node:crypto"
import { Agent, Cursor, JsonlLocalAgentStore, configureCursorSdk, createAgentPlatform } from "@cursor/sdk"
import { createSessionHub } from "./sdk-sessions.mjs"

const major = Number(process.versions.node.split(".")[0] ?? 0)
const minor = Number(process.versions.node.split(".")[1] ?? 0)
if (major < 22 || (major === 22 && minor < 13)) {
  process.stdout.write(JSON.stringify({ type: "error", message: `Cursor SDK needs Node.js 22.13 or newer (this runner is ${process.version}). Set CURSOR_ACP_NODE_BIN to a newer node.` }) + "\n")
  process.exit(1)
}

/** Long-lived hosts: avoid re-walking the tree every 20s (SDK default). Override with CURSOR_RIPWALK_CACHE_TTL_MS. */
const WORKSPACE_SCAN_TTL_MS = Number(process.env.CURSOR_RIPWALK_CACHE_TTL_MS || 30 * 60 * 1000)

const hub = createSessionHub()
let store = null
let storeRoot = null
let platform = null
let prewarmRelease = null
let prewarmedCwd = null
let prewarmedApiKey = null

function emit(message) {
  process.stdout.write(JSON.stringify(message) + "\n")
}

/** Shorter than the idle timeout, and at most 15 seconds. A silent live run must report in before the proxy gives up. */
function pulseEvery(idleTimeoutMs) {
  const idle = Number(idleTimeoutMs)
  const windowMs = Number.isFinite(idle) && idle > 0 ? idle : 300000
  return Math.min(15_000, Math.max(50, Math.floor(windowMs / 3)))
}

function diag(event, fields) {
  emit({ type: "diag", event, ...fields })
}

function customTools(tools, session) {
  const defined = {}
  for (const tool of tools ?? []) {
    defined[tool.name] = {
      description: tool.description || `Host tool ${tool.name}. OpenCode runs it and returns the result.`,
      inputSchema: tool.parameters && typeof tool.parameters === "object" ? tool.parameters : { type: "object", additionalProperties: true },
      execute(_args, context) {
        const id = context?.toolCallId || randomUUID()
        emit({ type: "tool", id, name: tool.name, arguments: JSON.stringify(_args ?? {}), sessionKey: session.sessionKey, requestId: session.requestId })
        return new Promise((resolve) => {
          session.waiters.set(id, resolve)
        })
      },
    }
  }
  return defined
}

/** Same shape as modelSelectionKey() in auto-models.ts. The runner cannot import that TypeScript module. */
function modelKey(cmd) {
  const params = Array.isArray(cmd.modelParams)
    ? cmd.modelParams.map((param) => ({ id: String(param.id), value: String(param.value) })).sort((left, right) => left.id.localeCompare(right.id))
    : []
  return JSON.stringify({ id: cmd.model || "auto-smart", params })
}

function ensureStore(stateRoot) {
  if (store && storeRoot === stateRoot) return
  storeRoot = stateRoot
  store = new JsonlLocalAgentStore(stateRoot)
  configureCursorSdk({
    local: {
      store,
      useHttp1ForAgent: process.env.CURSOR_SDK_HTTP1 === "1",
      workspaceScanCacheTtlMs: Number.isFinite(WORKSPACE_SCAN_TTL_MS) ? WORKSPACE_SCAN_TTL_MS : 30 * 60 * 1000,
    },
  })
}

function agentLocalOptions(cmd, tools) {
  return {
    cwd: cmd.cwd,
    store,
    settingSources: [],
    customTools: tools && Object.keys(tools).length ? tools : undefined,
  }
}

async function ensurePrewarm(cmd) {
  if (!cmd.cwd || !cmd.apiKey) return
  ensureStore(cmd.stateRoot || path.join(cmd.cwd, ".opencodev2-cursor-sdk"))
  if (prewarmRelease && prewarmedCwd === cmd.cwd && prewarmedApiKey === cmd.apiKey) return
  if (prewarmRelease) {
    try {
      await prewarmRelease()
    } catch {
      // Best effort; a later send() rebuilds.
    }
    prewarmRelease = null
    prewarmedCwd = null
    prewarmedApiKey = null
  }
  if (!platform) platform = await createAgentPlatform()
  try {
    prewarmRelease = await platform.prewarmLocalWorkspace({
      apiKey: cmd.apiKey,
      model: { id: "auto-smart" },
      name: "opencodev2-cursor",
      local: {
        cwd: cmd.cwd,
        store,
        settingSources: [],
      },
    })
    prewarmedCwd = cmd.cwd
    prewarmedApiKey = cmd.apiKey
  } catch (error) {
    emit({
      type: "warn",
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function ensureAgent(cmd, session) {
  const requestedModel = modelKey(cmd)
  if (
    session.agent
    && session.modelKey === requestedModel
    && (!cmd.agentId || session.agent.agentId === cmd.agentId)
  ) {
    return session.agent
  }
  ensureStore(cmd.stateRoot)
  await ensurePrewarm(cmd)
  const tools = customTools(cmd.tools, session)
  const model = { id: cmd.model || "auto-smart" }
  if (Array.isArray(cmd.modelParams) && cmd.modelParams.length) model.params = cmd.modelParams
  const options = {
    apiKey: cmd.apiKey,
    model,
    name: "opencodev2-cursor",
    local: agentLocalOptions(cmd, tools),
  }
  if (cmd.tools?.length) {
    options.tools = ["mcp"]
    options.disallowedTools = ["shell", "read", "edit", "grep", "glob", "delete", "task"]
  }
  // Resume only when the parent sends an agentId. A model change omits it, so this creates a new agent.
  session.agent = cmd.agentId ? await Agent.resume(cmd.agentId, options) : await Agent.create(options)
  session.modelKey = requestedModel
  emit({ type: "session", agentId: session.agent.agentId, sessionKey: session.sessionKey, requestId: session.requestId })
  return session.agent
}

async function startRun(session, prompt) {
  // local.force expires an orphaned active run on this agent only.
  try {
    return await session.agent.send(prompt, { local: { force: true } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/already has active run/i.test(message)) throw error
    const pending = session.run
    session.run = null
    for (const resolve of session.waiters.values()) resolve("(cancelled)")
    session.waiters.clear()
    if (pending) {
      try {
        await pending.cancel()
      } catch {
        // Already finished.
      }
    }
    return session.agent.send(prompt, { local: { force: true } })
  }
}

function finalError(session, requestId, message) {
  emit({
    type: "error",
    message,
    sessionKey: session?.sessionKey,
    requestId: requestId || session?.requestId,
  })
}

async function runTurn(cmd) {
  const session = hub.ensure(cmd.sessionKey)
  if ((cmd.toolResults ?? []).length > 0) {
    let missing = false
    for (const result of cmd.toolResults) {
      const delivered = hub.toolResult({ ...cmd, id: result.id, content: result.content })
      if (delivered.ok) diag("tool result received", { sessionKey: session.sessionKey, model: cmd.model, toolId: result.id })
      else missing = true
    }
    if (missing) {
      diag("orphan tool result", { sessionKey: session.sessionKey, model: cmd.model, reason: "turn toolResults" })
      finalError(session, cmd.requestId, "Tool result arrived after the Cursor run ended")
    }
    return
  }
  if (session.busy || session.run) {
    const previousId = session.requestId
    await hub.clear(session, "new turn")
    diag("run cancelled", { sessionKey: session.sessionKey, model: cmd.model, reason: "new turn" })
    emit({ type: "done", text: "", sessionKey: session.sessionKey, requestId: previousId })
  }
  session.busy = true
  session.requestId = cmd.requestId
  const generation = session.generation
  let pulse
  diag("turn start", { sessionKey: session.sessionKey, model: cmd.model, requestId: cmd.requestId })
  try {
    const current = await ensureAgent(cmd, session)
    if (session.generation !== generation) return
    const run = await startRun(session, cmd.prompt || "")
    if (session.generation !== generation) return
    session.run = run
    pulse = setInterval(() => {
      if (session.generation !== generation) return
      emit({ type: "keepalive", sessionKey: session.sessionKey, requestId: session.requestId })
    }, pulseEvery(cmd.idleTimeoutMs))
    pulse.unref()
    let sent = ""
    for await (const event of run.stream()) {
      if (session.generation !== generation) return
      if (event.type === "assistant") {
        const blocks = event.message?.content ?? []
        for (const block of blocks) {
          if (block.type !== "text" || typeof block.text !== "string") continue
          const text = block.text.startsWith(sent) ? block.text.slice(sent.length) : block.text
          sent = block.text.startsWith(sent) ? block.text : sent + block.text
          if (text) emit({ type: "text", text, sessionKey: session.sessionKey, requestId: session.requestId })
        }
      } else if (event.type === "thinking" && event.text) {
        emit({ type: "reasoning", text: event.text, sessionKey: session.sessionKey, requestId: session.requestId })
      }
    }
    if (session.generation !== generation) return
    const result = await run.wait()
    if (session.generation !== generation) return
    session.run = null
    if (result.status === "error") finalError(session, session.requestId, result.error?.message || "Cursor run failed")
    else emit({ type: "done", text: result.result, sessionKey: session.sessionKey, requestId: session.requestId })
  } catch (error) {
    if (session.generation === generation) {
      finalError(session, session.requestId, error instanceof Error ? error.message : String(error))
    }
  } finally {
    if (pulse) clearInterval(pulse)
    if (session.generation === generation) {
      session.busy = false
      session.run = null
      emit({ type: "idle", sessionKey: session.sessionKey, requestId: session.requestId })
    }
  }
}

function listedModel(model) {
  return {
    id: model.id,
    name: model.displayName || model.id,
    variants: (model.variants ?? []).map((variant) => ({
      name: variant.displayName,
      params: variant.params ?? [],
      isDefault: variant.isDefault === true,
    })),
  }
}

const modelFlights = new Map()

function modelsFor(apiKey) {
  let flight = modelFlights.get(apiKey)
  if (flight) return flight
  flight = Cursor.models.list({ apiKey }).finally(() => {
    if (modelFlights.get(apiKey) === flight) modelFlights.delete(apiKey)
  })
  modelFlights.set(apiKey, flight)
  return flight
}

async function listModels(cmd) {
  try {
    const models = await modelsFor(cmd.apiKey)
    emit({
      type: "models",
      id: cmd.id,
      models: models.map(listedModel),
    })
  } catch (error) {
    emit({ type: "error", id: cmd.id, message: error instanceof Error ? error.message : String(error) })
  }
}

async function warm(cmd) {
  const started = Date.now()
  try {
    const modelsPromise = modelsFor(cmd.apiKey)
    await ensurePrewarm(cmd)
    const models = await modelsPromise
    emit({
      type: "warm",
      id: cmd.id,
      ms: Date.now() - started,
      cwd: cmd.cwd,
      prewarmed: Boolean(prewarmRelease),
      models: models.map(listedModel),
    })
  } catch (error) {
    emit({ type: "error", id: cmd.id, message: error instanceof Error ? error.message : String(error) })
  }
}

async function prewarm(cmd) {
  try {
    await ensurePrewarm(cmd)
    emit({ type: "warm", id: cmd.id, cwd: cmd.cwd, prewarmed: Boolean(prewarmRelease), models: [] })
  } catch (error) {
    emit({ type: "error", id: cmd.id, message: error instanceof Error ? error.message : String(error) })
  }
}

function replyToMissing(cmd, message) {
  // The parent treats this exact message as "start a fresh turn", so the wording is part of the protocol.
  diag("orphan tool result", { sessionKey: cmd.sessionKey || "default", model: cmd.model, toolId: cmd.id, reason: "no run" })
  emit({
    type: "error",
    message,
    sessionKey: cmd.sessionKey || "default",
    requestId: cmd.requestId,
  })
}

const lines = readline.createInterface({ input: process.stdin })
lines.on("line", (line) => {
  let cmd
  try {
    cmd = JSON.parse(line)
  } catch {
    return
  }
  if (cmd.type === "tool_result") {
    const delivered = hub.toolResult(cmd)
    if (delivered.ok) {
      diag("tool result received", { sessionKey: delivered.sessionKey, model: cmd.model, toolId: cmd.id })
      return
    }
    replyToMissing(cmd, delivered.message)
    return
  }
  if (cmd.type === "cancel") {
    void hub.cancel(cmd.sessionKey, cmd.reason).then((result) => {
      const sessionKey = cmd.sessionKey || result.sessionKey
      diag("run cancelled", { sessionKey, model: cmd.model, reason: cmd.reason || "cancel" })
      emit({
        type: "error",
        message: "Cursor run was cancelled",
        sessionKey,
        requestId: cmd.requestId || result.requestId,
      })
    })
    return
  }
  if (cmd.type === "ping") {
    emit({ type: "pong" })
    return
  }
  if (cmd.type === "models") {
    void listModels(cmd)
    return
  }
  if (cmd.type === "warm") {
    void warm(cmd)
    return
  }
  if (cmd.type === "prewarm") {
    void prewarm(cmd)
    return
  }
  if (cmd.type === "turn") void runTurn(cmd)
})
