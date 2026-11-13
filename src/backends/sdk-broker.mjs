import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import readline from "node:readline"
import { spawn } from "node:child_process"

const cacheDir = process.argv[2]
const runnerScript = process.argv[3]
if (!cacheDir || !runnerScript) process.exit(1)

const lockPath = path.join(cacheDir, "sdk-broker.lock")
const infoPath = path.join(cacheDir, "sdk-broker.json")

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function clearStale() {
  let pid
  try {
    pid = Number(fs.readFileSync(lockPath, "utf8"))
  } catch {
    return
  }
  if (pidAlive(pid)) return
  try { fs.unlinkSync(lockPath) } catch { /* already gone */ }
  try { fs.unlinkSync(infoPath) } catch { /* no port file yet */ }
}

function tryLock() {
  try {
    const fd = fs.openSync(lockPath, "wx")
    fs.writeFileSync(fd, String(process.pid))
    return fd
  } catch {
    return undefined
  }
}

fs.mkdirSync(cacheDir, { recursive: true })
clearStale()
const lockFd = tryLock()
if (lockFd === undefined) process.exit(0)

function logLine(message, extra) {
  try {
    fs.appendFileSync(path.join(cacheDir, "opencodev2-cursor.log"), JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      message,
      extra,
    }) + "\n")
  } catch {
    // Logging must not stop the worker.
  }
}

let shutting = false
const owners = new Map()
const sockets = new Set()
const active = new Set()

function shutdown() {
  if (shutting) return
  shutting = true
  try { runner.kill() } catch { /* already gone */ }
  for (const socket of sockets) socket.destroy()
  server.close()
  try { fs.closeSync(lockFd) } catch { /* closed */ }
  try { fs.unlinkSync(lockPath) } catch { /* already removed */ }
  try { fs.unlinkSync(infoPath) } catch { /* already removed */ }
  process.exit(0)
}

function claim(cmd, socket) {
  if (typeof cmd.requestId === "string") owners.set(cmd.requestId, socket)
  if (typeof cmd.id === "string") owners.set(cmd.id, socket)
  if (typeof cmd.sessionKey === "string") owners.set(cmd.sessionKey, socket)
}

const liveTurn = new Map()
const queuedTurns = new Map()

function holdTurn(cmd, socket, line) {
  if (cmd.type !== "turn" || typeof cmd.sessionKey !== "string" || typeof cmd.requestId !== "string") return false
  const current = liveTurn.get(cmd.sessionKey)
  if (current && current.socket !== socket && !current.socket.destroyed) {
    const queue = queuedTurns.get(cmd.sessionKey) ?? []
    queue.push({ line, socket, requestId: cmd.requestId, sessionKey: cmd.sessionKey })
    queuedTurns.set(cmd.sessionKey, queue)
    return true
  }
  liveTurn.set(cmd.sessionKey, { socket, requestId: cmd.requestId })
  return false
}

function advanceTurn(sessionKey) {
  const queue = queuedTurns.get(sessionKey) ?? []
  while (queue.length > 0 && queue[0].socket.destroyed) queue.shift()
  const next = queue.shift()
  if (!queue.length) queuedTurns.delete(sessionKey)
  if (!next) {
    liveTurn.delete(sessionKey)
    return
  }
  liveTurn.set(sessionKey, { socket: next.socket, requestId: next.requestId })
  owners.set(next.requestId, next.socket)
  owners.set(sessionKey, next.socket)
  runner.stdin.write(next.line + "\n")
}

function releaseTurn(event) {
  if (event.type !== "done" && event.type !== "error") return
  for (const [sessionKey, current] of liveTurn) {
    if (current.requestId !== event.requestId) continue
    advanceTurn(sessionKey)
    return
  }
}

function cancelQueued(cmd, socket) {
  if (cmd.type !== "cancel") return false
  const queue = queuedTurns.get(cmd.sessionKey)
  const index = queue?.findIndex((turn) => turn.requestId === cmd.requestId && turn.socket === socket) ?? -1
  if (index < 0) return false
  queue.splice(index, 1)
  if (!queue.length) queuedTurns.delete(cmd.sessionKey)
  owners.delete(cmd.requestId)
  socket.write(JSON.stringify({
    type: "error",
    message: "Cursor run was cancelled",
    requestId: cmd.requestId,
    sessionKey: cmd.sessionKey,
  }) + "\n")
  return true
}

function route(line, event) {
  const key = event.requestId || event.id || event.sessionKey
  const socket = key ? owners.get(key) : undefined
  if (socket && !socket.destroyed) {
    socket.write(line + "\n")
    return
  }
  if (!key) {
    for (const client of sockets) {
      if (!client.destroyed) client.write(line + "\n")
    }
  }
}

const runner = spawn(process.execPath, [runnerScript], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: process.env,
})
runner.stderr.on("data", (chunk) => {
  const text = chunk.toString().trim()
  if (text) logLine("sdk runner", text)
})
runner.on("exit", () => shutdown())
readline.createInterface({ input: runner.stdout }).on("line", (line) => {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return
  }
  route(line, event)
  releaseTurn(event)
})

const server = net.createServer((socket) => {
  if (shutting) {
    socket.destroy()
    return
  }
  socket.setNoDelay(true)
  socket.setEncoding("utf8")
  sockets.add(socket)
  let buffer = ""
  socket.on("data", (chunk) => {
    buffer += chunk
    const parts = buffer.split("\n")
    buffer = parts.pop() ?? ""
    for (const part of parts) {
      if (!part.trim()) continue
      let cmd
      try {
        cmd = JSON.parse(part)
      } catch {
        continue
      }
      active.add(socket)
      if (cancelQueued(cmd, socket)) continue
      if (cmd.type === "cancel") {
        const current = liveTurn.get(cmd.sessionKey)
        // The runner cancels by session. A late abort must not cancel its replacement.
        if (current && (current.requestId !== cmd.requestId || current.socket !== socket)) continue
      }
      if (holdTurn(cmd, socket, part)) continue
      claim(cmd, socket)
      if (cmd.type === "tool_result") {
        const current = liveTurn.get(cmd.sessionKey)
        if (current) {
          current.requestId = cmd.requestId
          current.socket = socket
        }
      }
      runner.stdin.write(part + "\n")
    }
  })
  socket.on("error", () => socket.destroy())
  socket.on("close", () => {
    sockets.delete(socket)
    const wasActive = active.delete(socket)
    for (const [key, owner] of owners) {
      if (owner === socket) owners.delete(key)
    }
    if (wasActive && active.size === 0) {
      shutdown()
      return
    }
    for (const [sessionKey, queue] of queuedTurns) {
      const remaining = queue.filter((turn) => turn.socket !== socket)
      if (remaining.length) queuedTurns.set(sessionKey, remaining)
      else queuedTurns.delete(sessionKey)
    }
    for (const [sessionKey, current] of liveTurn) {
      if (current.socket === socket) advanceTurn(sessionKey)
    }
  })
})

server.listen(0, "127.0.0.1", () => {
  if (shutting) return
  const address = server.address()
  const port = address && typeof address !== "string" ? address.port : 0
  const tmp = `${infoPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, port }))
  fs.renameSync(tmp, infoPath)
  logLine("sdk broker started", { pid: process.pid, port })
})

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
