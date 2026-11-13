import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const brokerScript = fileURLToPath(new URL("./sdk-broker.mjs", import.meta.url))

function writeFakeRunner(dir: string): string {
  const runner = path.join(dir, "fake-runner.mjs")
  fs.writeFileSync(runner, `
import readline from "node:readline"
const lines = readline.createInterface({ input: process.stdin })
lines.on("line", (line) => {
  const cmd = JSON.parse(line)
  if (cmd.type !== "turn") return
  process.stdout.write(JSON.stringify({ type: "text", text: cmd.prompt, requestId: cmd.requestId }) + "\\n")
})
`)
  return runner
}

async function waitForInfo(file: string): Promise<{ port: number; pid: number }> {
  const started = Date.now()
  while (Date.now() - started < 3_000) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { port: number; pid: number }
      if (parsed.port && parsed.pid) return parsed
    } catch {
      // The broker writes the file after it listens.
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("broker did not publish a port")
}

function openClient(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1")
    const fail = (error: Error) => reject(error)
    socket.once("error", fail)
    socket.once("connect", () => {
      socket.off("error", fail)
      socket.on("error", () => {})
      resolve(socket)
    })
  })
}

function lineQueue(socket: net.Socket): { next: () => Promise<string> } {
  const pending: string[] = []
  const waiters: Array<(line: string) => void> = []
  const lines = createInterface({ input: socket })
  lines.on("line", (line) => {
    const waiter = waiters.shift()
    if (waiter) waiter(line)
    else pending.push(line)
  })
  return {
    next() {
      const queued = pending.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      return new Promise((resolve) => waiters.push(resolve))
    },
  }
}

async function within<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for broker response")), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe("shared sdk broker", () => {
  const children: ChildProcess[] = []
  const clients: net.Socket[] = []
  const dirs: string[] = []

  afterEach(() => {
    for (const socket of clients) {
      socket.removeAllListeners("error")
      socket.on("error", () => {})
      socket.destroy()
    }
    clients.length = 0
    for (const child of children) {
      try { child.kill() } catch { /* already gone */ }
    }
    children.length = 0
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it("lets two projects share one runner, and one disconnect leaves the other running", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocv2-broker-"))
    dirs.push(dir)
    const runner = writeFakeRunner(dir)
    const child = spawn(process.execPath, [brokerScript, dir, runner], { stdio: "ignore", windowsHide: true })
    children.push(child)
    const info = await waitForInfo(path.join(dir, "sdk-broker.json"))
    const first = await openClient(info.port)
    const second = await openClient(info.port)
    clients.push(first, second)
    const firstLines = lineQueue(first)
    const secondLines = lineQueue(second)
    first.write(JSON.stringify({ type: "turn", requestId: "req-a", sessionKey: "ses-a", prompt: "alpha" }) + "\n")
    second.write(JSON.stringify({ type: "turn", requestId: "req-b", sessionKey: "ses-b", prompt: "beta" }) + "\n")
    const firstText = JSON.parse(await firstLines.next()) as { text?: string; requestId?: string }
    const secondText = JSON.parse(await secondLines.next()) as { text?: string; requestId?: string }
    expect(firstText).toMatchObject({ text: "alpha", requestId: "req-a" })
    expect(secondText).toMatchObject({ text: "beta", requestId: "req-b" })
    first.end()
    second.write(JSON.stringify({ type: "turn", requestId: "req-c", sessionKey: "ses-b", prompt: "still-beta" }) + "\n")
    const third = JSON.parse(await secondLines.next()) as { text?: string }
    expect(third.text).toBe("still-beta")
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
    second.end()
    expect(await exited).toBe(0)
  })

  it("does not let a second project cancel a turn that is already running", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocv2-broker-"))
    dirs.push(dir)
    const seen = path.join(dir, "seen.txt")
    const runner = path.join(dir, "holding-runner.mjs")
    fs.writeFileSync(runner, `
import fs from "node:fs"
import readline from "node:readline"
const lines = readline.createInterface({ input: process.stdin })
lines.on("line", (line) => {
  const cmd = JSON.parse(line)
  if (cmd.type !== "turn") return
  fs.appendFileSync(process.env.BROKER_SEEN, cmd.prompt + "\\n")
  if (cmd.prompt === "hold") {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ type: "done", text: "held", requestId: cmd.requestId, sessionKey: cmd.sessionKey }) + "\\n")
    }, 250)
    return
  }
  process.stdout.write(JSON.stringify({ type: "text", text: cmd.prompt, requestId: cmd.requestId, sessionKey: cmd.sessionKey }) + "\\n")
})
`)
    const child = spawn(process.execPath, [brokerScript, dir, runner], {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, BROKER_SEEN: seen },
    })
    children.push(child)
    const info = await waitForInfo(path.join(dir, "sdk-broker.json"))
    const first = await openClient(info.port)
    const second = await openClient(info.port)
    clients.push(first, second)
    const firstLines = lineQueue(first)
    const secondLines = lineQueue(second)
    first.write(JSON.stringify({ type: "turn", requestId: "req-hold", sessionKey: "ses-same", prompt: "hold" }) + "\n")
    const started = Date.now()
    while (!fs.existsSync(seen) || !fs.readFileSync(seen, "utf8").includes("hold")) {
      if (Date.now() - started > 2_000) throw new Error("first turn was not forwarded")
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    second.write(JSON.stringify({ type: "turn", requestId: "req-next", sessionKey: "ses-same", prompt: "next" }) + "\n")
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(fs.readFileSync(seen, "utf8").trim()).toBe("hold")
    expect(JSON.parse(await firstLines.next())).toMatchObject({ type: "done", text: "held", requestId: "req-hold" })
    expect(JSON.parse(await secondLines.next())).toMatchObject({ type: "text", text: "next", requestId: "req-next" })
    expect(fs.readFileSync(seen, "utf8").trim().split(/\r?\n/)).toEqual(["hold", "next"])
  })

  it("releases a queued turn after a tool continuation completes with a new request id", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocv2-broker-"))
    dirs.push(dir)
    const runner = path.join(dir, "tool-runner.mjs")
    fs.writeFileSync(runner, `
import readline from "node:readline"
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line)
  const type = cmd.type === "tool_result" ? "done" : "tool"
  process.stdout.write(JSON.stringify({ type, requestId: cmd.requestId, sessionKey: cmd.sessionKey }) + "\\n")
})
`)
    const child = spawn(process.execPath, [brokerScript, dir, runner], { stdio: "ignore", windowsHide: true })
    children.push(child)
    const info = await waitForInfo(path.join(dir, "sdk-broker.json"))
    const first = await openClient(info.port)
    const second = await openClient(info.port)
    clients.push(first, second)
    const firstLines = lineQueue(first)
    const secondLines = lineQueue(second)
    first.write(JSON.stringify({ type: "turn", requestId: "initial", sessionKey: "same" }) + "\n")
    expect(JSON.parse(await firstLines.next()).type).toBe("tool")
    second.write(JSON.stringify({ type: "turn", requestId: "queued", sessionKey: "same" }) + "\n")
    first.write(JSON.stringify({ type: "tool_result", requestId: "continuation", sessionKey: "same", id: "tool-1" }) + "\n")
    expect(JSON.parse(await firstLines.next()).type).toBe("done")
    const next = await Promise.race([
      secondLines.next(),
      new Promise<string>((resolve) => setTimeout(() => resolve('{}'), 500)),
    ])
    expect(JSON.parse(next)).toMatchObject({ type: "tool", requestId: "queued" })
  })

  it("cancels a queued request without cancelling the running session", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocv2-broker-"))
    dirs.push(dir)
    const runner = writeFakeRunner(dir)
    const child = spawn(process.execPath, [brokerScript, dir, runner], { stdio: "ignore", windowsHide: true })
    children.push(child)
    const info = await waitForInfo(path.join(dir, "sdk-broker.json"))
    const first = await openClient(info.port)
    const second = await openClient(info.port)
    clients.push(first, second)
    const firstLines = lineQueue(first)
    const secondLines = lineQueue(second)
    first.write(JSON.stringify({ type: "turn", requestId: "running", sessionKey: "same", prompt: "running" }) + "\n")
    expect(JSON.parse(await firstLines.next()).text).toBe("running")
    second.write(JSON.stringify({ type: "turn", requestId: "queued", sessionKey: "same", prompt: "queued" }) + "\n")
    second.write(JSON.stringify({ type: "cancel", requestId: "queued", sessionKey: "same" }) + "\n")
    const cancelled = await Promise.race([
      secondLines.next(),
      new Promise<string>((resolve) => setTimeout(() => resolve('{}'), 500)),
    ])
    expect(JSON.parse(cancelled)).toMatchObject({ type: "error", requestId: "queued", message: "Cursor run was cancelled" })
    first.write(JSON.stringify({ type: "turn", requestId: "still-running", sessionKey: "same", prompt: "still-running" }) + "\n")
    expect(JSON.parse(await firstLines.next()).text).toBe("still-running")
  })

  it("starts an already queued turn when its previous owner disconnects", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocv2-broker-"))
    dirs.push(dir)
    const runner = writeFakeRunner(dir)
    const child = spawn(process.execPath, [brokerScript, dir, runner], { stdio: "ignore", windowsHide: true })
    children.push(child)
    const info = await waitForInfo(path.join(dir, "sdk-broker.json"))
    const first = await openClient(info.port)
    const second = await openClient(info.port)
    clients.push(first, second)
    const firstLines = lineQueue(first)
    const secondLines = lineQueue(second)
    first.write(JSON.stringify({ type: "turn", requestId: "old", sessionKey: "same", prompt: "old" }) + "\n")
    expect(JSON.parse(await within(firstLines.next())).text).toBe("old")
    const queued = secondLines.next()
    second.write(JSON.stringify({ type: "turn", requestId: "next", sessionKey: "same", prompt: "next" }) + "\n")
    const beforeDisconnect = await Promise.race([
      queued.then(() => "forwarded"),
      new Promise<string>((resolve) => setTimeout(() => resolve("queued"), 100)),
    ])
    expect(beforeDisconnect).toBe("queued")
    first.end()
    expect(JSON.parse(await within(queued))).toMatchObject({ type: "text", requestId: "next", text: "next" })
  })

  it("preserves UTF-8 characters split across socket chunks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocv2-broker-"))
    dirs.push(dir)
    const runner = writeFakeRunner(dir)
    const child = spawn(process.execPath, [brokerScript, dir, runner], { stdio: "ignore", windowsHide: true })
    children.push(child)
    const info = await waitForInfo(path.join(dir, "sdk-broker.json"))
    const socket = await openClient(info.port)
    clients.push(socket)
    const lines = lineQueue(socket)
    const prompt = "caf\u00e9 \u6f22\u5b57"
    const data = Buffer.from(JSON.stringify({ type: "turn", requestId: "utf8", sessionKey: "utf8", prompt }) + "\n")
    const split = data.indexOf(Buffer.from("\u00e9")) + 1
    socket.write(data.subarray(0, split))
    await new Promise((resolve) => setTimeout(resolve, 100))
    socket.write(data.subarray(split))
    expect(JSON.parse(await within(lines.next())).text).toBe(prompt)
  })

  it("ignores late cancellations but forwards cancellation of the current request", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocv2-broker-"))
    dirs.push(dir)
    const seen = path.join(dir, "commands.jsonl")
    const runner = path.join(dir, "cancel-runner.mjs")
    fs.writeFileSync(runner, `
import fs from "node:fs"
import readline from "node:readline"
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line)
  fs.appendFileSync(process.env.BROKER_SEEN, line + "\\n")
  if (cmd.type === "turn") process.stdout.write(JSON.stringify({ type: "text", text: cmd.prompt, requestId: cmd.requestId }) + "\\n")
})
`)
    const child = spawn(process.execPath, [brokerScript, dir, runner], {
      stdio: "ignore", windowsHide: true, env: { ...process.env, BROKER_SEEN: seen },
    })
    children.push(child)
    const info = await waitForInfo(path.join(dir, "sdk-broker.json"))
    const socket = await openClient(info.port)
    clients.push(socket)
    const lines = lineQueue(socket)
    for (const requestId of ["old", "current"]) {
      socket.write(JSON.stringify({ type: "turn", requestId, sessionKey: "same", prompt: requestId }) + "\n")
      expect(JSON.parse(await within(lines.next())).text).toBe(requestId)
    }
    socket.write(JSON.stringify({ type: "cancel", requestId: "old", sessionKey: "same" }) + "\n")
    socket.write(JSON.stringify({ type: "turn", requestId: "barrier", sessionKey: "other", prompt: "barrier" }) + "\n")
    let response
    do {
      response = JSON.parse(await within(lines.next()))
    } while (response.requestId !== "barrier")
    const commands = fs.readFileSync(seen, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string })
    expect(commands.map((cmd) => cmd.type)).toEqual(["turn", "turn", "turn"])
    socket.write(JSON.stringify({ type: "cancel", requestId: "current", sessionKey: "same" }) + "\n")
    socket.write(JSON.stringify({ type: "turn", requestId: "after-cancel", sessionKey: "other", prompt: "after-cancel" }) + "\n")
    expect(JSON.parse(await within(lines.next())).requestId).toBe("after-cancel")
    const finalCommands = fs.readFileSync(seen, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; requestId: string })
    expect(finalCommands.filter((cmd) => cmd.type === "cancel")).toEqual([
      { type: "cancel", requestId: "current", sessionKey: "same" },
    ])
  })
})
