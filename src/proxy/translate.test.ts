import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { isLoopback, startProxy, startSharedProxy } from "./server.js"
import { prepareTurn } from "./translate.js"
import { mapCursorTool } from "./tools.js"
import { chooseBackend } from "../backends/select.js"
import { launchFor, launchFromPath, resolveAgentRuntime } from "../util/windows.js"
import { parseStreamJsonLine, parseModelList } from "../backends/stream-json.js"
import { encodeConnectFrames, encodeRunRequest, decodeConnectData, stringsInProtobuf, toolCallFromText } from "../backends/native/proto.js"
import { ensureSdkApiKey, refreshNativeToken, tokenExpiry } from "../backends/native/auth.js"
import { isTitleRequest, localTitle } from "./title.js"

describe("prepareTurn", () => {
  it("keeps only trailing tool results as a continuation", () => {
    const turn = prepareTurn({
      model: "composer-2",
      messages: [
        { role: "user", content: "read the file" },
        { role: "assistant", content: "", tool_calls: [{ id: "1", function: { name: "read", arguments: "{\"path\":\"a\"}" } }] },
        { role: "tool", tool_call_id: "1", content: "hello" },
      ],
      tools: [{ function: { name: "read", description: "Read" } }],
    })
    expect(turn.continuation).toBe(true)
    expect(turn.toolResults).toEqual([{ id: "1", content: "hello" }])
    expect(turn.tools.map((tool) => tool.name)).toEqual(["read"])
    expect(turn.prompt).toContain("read the file")
  })

  it("extracts the latest user message separately from prior history", () => {
    const turn = prepareTurn({
      model: "composer-2.5",
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "Greeting" },
        { role: "user", content: "which model is this?" },
      ],
    })
    expect(turn.lastUserPrompt).toBe("which model is this?")
    expect(turn.prompt).toContain("Assistant:\nGreeting")
  })
})

describe("tool mapping", () => {
  const advertised = new Set(["read", "shell", "subagent"])

  it("maps Cursor names onto advertised OpenCode tools", () => {
    expect(mapCursorTool("Shell", advertised)).toBe("shell")
    expect(mapCursorTool("bash", advertised)).toBe("shell")
    expect(mapCursorTool("Task", advertised)).toBe("subagent")
    expect(mapCursorTool("str_replace", new Set(["edit"]))).toBe("edit")
    expect(mapCursorTool("ls", new Set(["glob"]))).toBe("glob")
    expect(mapCursorTool("grep", advertised)).toBeUndefined()
  })
})

describe("backend selection", () => {
  it("prefers the SDK for an API key and native for an OAuth token", () => {
    expect(chooseBackend("auto", { kind: "api-key", apiKey: "crsr" })).toBe("sdk")
    expect(chooseBackend("auto", { kind: "native", accessToken: "token" })).toBe("native")
    expect(chooseBackend("auto", { kind: "cli" })).toBe("cli")
    expect(chooseBackend("cli", { kind: "api-key", apiKey: "crsr" })).toBe("cli")
  })
})

describe("cursor-agent launcher", () => {
  it("runs a ps1 sibling instead of the cmd shim", () => {
    const lookup = {
      pathEnv: "C:\\bin",
      delimiter: ";",
      pathExt: ".CMD;.PS1",
      exists: (file: string) => file.endsWith("cursor-agent.cmd") || file.endsWith("cursor-agent.ps1"),
      sibling: (file: string, name: string) => (name.endsWith(".ps1") ? file.replace(/\.cmd$/i, ".ps1") : undefined),
    }
    const launch = launchFromPath("cursor-agent", lookup)
    expect(launch?.command).toBe("powershell.exe")
    expect(launch?.args).toContain("-File")
    expect(launch?.args.at(-1)).toMatch(/cursor-agent\.ps1$/)
  })

  it("keeps a direct executable", () => {
    expect(launchFor("C:\\bin\\cursor-agent.exe", { sibling: () => undefined }).command).toBe("C:\\bin\\cursor-agent.exe")
  })

  it("finds the newest cursor-agent runtime beside the launcher", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-runtime-"))
    for (const version of ["2026.01.01-aaaa", "2026.10.22-bbbb"]) {
      const dir = path.join(root, "versions", version)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "node.exe"), "")
      fs.writeFileSync(path.join(dir, "index.js"), "")
    }
    const runtime = resolveAgentRuntime({
      command: "powershell.exe",
      args: ["-File", path.join(root, "cursor-agent.ps1")],
    }, fs.existsSync, "win32")
    expect(runtime?.node).toBe(path.join(root, "versions", "2026.10.22-bbbb", "node.exe"))
    expect(runtime?.index).toBe(path.join(root, "versions", "2026.10.22-bbbb", "index.js"))
  })

  it("probes only the bare launcher name on macOS and Linux", () => {
    const probed: string[] = []
    const launch = launchFromPath("cursor-agent", {
      pathEnv: "/usr/local/bin:/home/me/.local/bin",
      delimiter: ":",
      pathExt: "",
      exists: (file: string) => {
        probed.push(file)
        return file.includes("me") && file.endsWith("cursor-agent")
      },
      sibling: () => undefined,
    })
    expect(launch).toEqual({ command: path.join("/home/me/.local/bin", "cursor-agent"), args: [] })
    expect(probed.every((file) => file.endsWith("cursor-agent"))).toBe(true)
  })

  it("finds the node binary through a symlinked launcher on macOS and Linux", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-runtime-posix-"))
    const versionDir = path.join(root, "share", "versions", "2026.10.22-bbbb")
    fs.mkdirSync(versionDir, { recursive: true })
    fs.writeFileSync(path.join(versionDir, "node"), "")
    fs.writeFileSync(path.join(versionDir, "index.js"), "")
    const linked = path.join(root, "bin", "cursor-agent")
    const runtime = resolveAgentRuntime(
      { command: linked, args: [] },
      fs.existsSync,
      "linux",
      () => path.join(versionDir, "cursor-agent"),
    )
    expect(runtime?.node).toBe(path.join(versionDir, "node"))
    expect(runtime?.index).toBe(path.join(versionDir, "index.js"))
  })

  it("ignores node.exe when the platform is not Windows", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-runtime-mismatch-"))
    fs.writeFileSync(path.join(root, "node.exe"), "")
    fs.writeFileSync(path.join(root, "index.js"), "")
    expect(resolveAgentRuntime({ command: path.join(root, "cursor-agent"), args: [] }, fs.existsSync, "linux")).toBeUndefined()
  })
})

describe("stream-json", () => {
  it("reads assistant text and a started tool call", () => {
    const text = parseStreamJsonLine(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "pong" }] },
    }))
    expect(text).toEqual([{ type: "text", text: "pong" }])
    const call = parseStreamJsonLine(JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "c1",
      tool_call: { readToolCall: { args: { path: "a.txt" } } },
    }))
    expect(call[0]).toMatchObject({ type: "tool_call", id: "c1", name: "read" })
  })

  it("parses a plain model list", () => {
    expect(parseModelList("composer-2\nauto\n")).toEqual([
      { id: "composer-2", name: "composer-2" },
      { id: "auto", name: "auto" },
    ])
    expect(parseModelList("grok-4.7-high - Grok 4.7 High\n")).toEqual([
      { id: "grok-4.7-high", name: "Grok 4.7 High" },
    ])
  })
})

describe("connect frames", () => {
  it("round-trips a run request", () => {
    const payload = encodeRunRequest("composer-2", "Reply with PONG")
    const frames = decodeConnectData(encodeConnectFrames(payload))
    expect(stringsInProtobuf(frames[0]!)).toEqual(["composer-2", "Reply with PONG"])
  })

  it("includes model params, tools, and tool results", () => {
    const payload = encodeRunRequest("auto-smart", "Reply with PONG", {
      modelParams: [{ id: "optimize_for", value: "cost" }],
      tools: [{ name: "read" }],
      toolResults: [{ id: "1", content: "hello" }],
    })
    expect(stringsInProtobuf(payload)).toEqual([
      "auto-smart",
      "Reply with PONG",
      JSON.stringify([{ id: "optimize_for", value: "cost" }]),
      JSON.stringify([{ name: "read" }]),
      JSON.stringify([{ id: "1", content: "hello" }]),
    ])
  })

  it("keeps unicode text and recognizes an explicit tool-call payload", () => {
    expect(stringsInProtobuf(encodeRunRequest("composer-2", "Répondre"))).toEqual(["composer-2", "Répondre"])
    expect(toolCallFromText(JSON.stringify({ type: "tool_call", id: "c1", name: "read", arguments: "{\"path\":\"a\"}" }))).toEqual({
      id: "c1",
      name: "read",
      arguments: "{\"path\":\"a\"}",
    })
    expect(toolCallFromText("Répondre")).toBeUndefined()
  })
})

describe("proxy auth", () => {
  it("treats IPv4 and IPv6 loopback as local", () => {
    expect(isLoopback("127.0.0.1")).toBe(true)
    expect(isLoopback("::1")).toBe(true)
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true)
    expect(isLoopback("192.168.1.5")).toBe(false)
  })

  it("accepts a loopback chat request that carries the Cursor credential instead of the proxy token", async () => {
    const backend = {
      id: "cli" as const,
      async listModels() {
        return []
      },
      async *run() {
        yield { type: "text" as const, text: "PONG" }
        yield { type: "done" as const }
      },
    }
    const proxy = await startProxy({
      getAuth: async () => ({ kind: "cli" }),
      backends: { cli: backend, sdk: backend, native: backend },
      fallbackDirectory: () => process.cwd(),
      models: () => [],
    })
    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer crsr_user_key", "content-type": "application/json" },
        body: JSON.stringify({ model: "auto", stream: false, messages: [{ role: "user", content: "hi" }] }),
      })
      const json = await response.json() as { choices: Array<{ message: { content: string } }> }
      expect(response.status).toBe(200)
      expect(json.choices[0]?.message.content).toBe("PONG")
    } finally {
      await proxy.close()
    }
  })

  it("runs the Cursor id for the selected picker variant", async () => {
    const seen: Array<{ model: string; modelParams?: Array<{ id: string; value: string }> }> = []
    const backend = {
      id: "cli" as const,
      async listModels() {
        return []
      },
      async *run(request: { model: string; modelParams?: Array<{ id: string; value: string }> }) {
        seen.push({ model: request.model, modelParams: request.modelParams })
        yield { type: "done" as const, text: "ok" }
      },
    }
    const proxy = await startProxy({
      getAuth: async () => ({ kind: "cli" }),
      backends: { cli: backend, sdk: backend, native: backend },
      fallbackDirectory: () => process.cwd(),
      models: () => [],
      selectModel: (model, variant) => variant === "high-fast" ? `${model.slice(0, -1)},reasoning=high,fast=true]` : model,
    })
    try {
      await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencodev2-cursor-variant": "high-fast" },
        body: JSON.stringify({ model: "gpt-5.6-sol[context=272k]", stream: false, messages: [{ role: "user", content: "hi" }] }),
      })
      expect(seen[0]).toEqual({
        model: "gpt-5.6-sol",
        modelParams: [
          { id: "context", value: "272k" },
          { id: "reasoning", value: "high" },
          { id: "fast", value: "true" },
        ],
      })
    } finally {
      await proxy.close()
    }
  })

  it("flushes the first SSE chunk before the backend finishes the turn", async () => {
    let release!: () => void
    const rest = new Promise<void>((resolve) => { release = resolve })
    const backend = {
      id: "cli" as const,
      async listModels() {
        return []
      },
      async *run() {
        yield { type: "text" as const, text: "first" }
        await rest
        yield { type: "text" as const, text: " second" }
        yield { type: "done" as const }
      },
    }
    const proxy = await startProxy({
      getAuth: async () => ({ kind: "cli" }),
      backends: { cli: backend, sdk: backend, native: backend },
      fallbackDirectory: () => process.cwd(),
      models: () => [],
    })
    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
      })
      const reader = response.body!.getReader()
      const first = new TextDecoder().decode((await reader.read()).value)
      expect(first).toContain("first")
      release()
      let tail = ""
      for (;;) {
        const piece = await reader.read()
        if (piece.done) break
        tail += new TextDecoder().decode(piece.value)
      }
      expect(tail).toContain("second")
    } finally {
      await proxy.close()
    }
  })

  it("ends a silent stream with an error and [DONE], and releases the turn", async () => {
    let calls = 0
    let held = false
    const backend = {
      id: "cli" as const,
      async listModels() {
        return []
      },
      async *run(request: { signal: AbortSignal }) {
        calls += 1
        if (calls > 1) {
          yield { type: "text" as const, text: "next" }
          yield { type: "done" as const }
          return
        }
        held = true
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve()
          else request.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        held = false
      },
    }
    const proxy = await startProxy({
      getAuth: async () => ({ kind: "cli" }),
      backends: { cli: backend, sdk: backend, native: backend },
      fallbackDirectory: () => process.cwd(),
      models: () => [],
      idleTimeoutMs: 40,
      turnTimeoutMs: 5_000,
    })
    try {
      const first = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "grok-4.7", stream: true, messages: [{ role: "user", content: "hi" }] }),
      })
      const body = await first.text()
      expect(body).toContain("No Cursor output")
      expect(body).toContain("data: [DONE]")
      expect(held).toBe(false)
      const second = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "grok-4.7", stream: true, messages: [{ role: "user", content: "hi" }] }),
      })
      const follow = await second.text()
      expect(follow).toContain("next")
      expect(follow).toContain("data: [DONE]")
    } finally {
      await proxy.close()
    }
  })

  it("releases a silent turn when the client aborts", async () => {
    let calls = 0
    let released = false
    const backend = {
      id: "cli" as const,
      async listModels() {
        return []
      },
      async *run(request: { signal: AbortSignal }) {
        calls += 1
        if (calls > 1) {
          yield { type: "text" as const, text: "next" }
          yield { type: "done" as const }
          return
        }
        request.signal.addEventListener("abort", () => {
          released = true
        }, { once: true })
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve()
          else request.signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    }
    const proxy = await startProxy({
      getAuth: async () => ({ kind: "cli" }),
      backends: { cli: backend, sdk: backend, native: backend },
      fallbackDirectory: () => process.cwd(),
      models: () => [],
      idleTimeoutMs: 30_000,
      turnTimeoutMs: 60_000,
    })
    try {
      const abort = new AbortController()
      const pending = fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "grok-4.7", stream: true, messages: [{ role: "user", content: "hi" }] }),
        signal: abort.signal,
      })
      const response = await pending
      const reader = response.body!.getReader()
      const reading = reader.read()
      abort.abort()
      await reading.catch(() => undefined)
      const deadline = Date.now() + 1_000
      while (!released && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(released).toBe(true)
      const second = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "grok-4.7", stream: false, messages: [{ role: "user", content: "hi" }] }),
      })
      const json = await second.json() as { choices: Array<{ message: { content: string } }> }
      expect(json.choices[0]?.message.content).toBe("next")
    } finally {
      await proxy.close()
    }
  })
})

describe("shared proxy", () => {
  it("uses the latest plugin instance and falls back when that instance closes", async () => {
    const backend = (label: string) => ({
      id: "cli" as const,
      async listModels() {
        return []
      },
      async *run() {
        yield { type: "text" as const, text: label }
        yield { type: "done" as const }
      },
    })
    const deps = (label: string) => ({
      getAuth: async () => ({ kind: "cli" as const }),
      backends: { cli: backend(label), sdk: backend(label), native: backend(label) },
      fallbackDirectory: () => process.cwd(),
      models: () => [],
    })
    const first = await startSharedProxy(deps("first"))
    const second = await startSharedProxy(deps("second"))
    const post = () => fetch(`http://127.0.0.1:${first.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "composer-2", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    try {
      expect(second.port).toBe(first.port)
      const whileSecond = await (await post()).json() as { choices: Array<{ message: { content: string } }> }
      await second.close()
      const afterSecond = await (await post()).json() as { choices: Array<{ message: { content: string } }> }
      expect(whileSecond.choices[0]?.message.content).toBe("second")
      expect(afterSecond.choices[0]?.message.content).toBe("first")
    } finally {
      await second.close()
      await first.close()
    }
  })
})

describe("local session titles", () => {
  it("detects OpenChamber-style title prompts and skips normal chat", () => {
    expect(isTitleRequest(prepareTurn({
      messages: [
        { role: "system", content: "Generate a short session title of 1-2 words for this chat." },
        { role: "user", content: "hello there" },
      ],
    }))).toBe(true)
    expect(isTitleRequest(prepareTurn({
      messages: [{ role: "user", content: "what is the weather in Brisbane" }],
      tools: [{ function: { name: "read" } }],
    }))).toBe(false)
    expect(isTitleRequest(prepareTurn({
      messages: [{ role: "user", content: "what is the weather in Brisbane" }],
    }))).toBe(false)
  })

  it("builds a short title from the user text", () => {
    expect(localTitle("hello there friend")).toBe("Hello There Friend")
    expect(localTitle("")).toBe("New chat")
  })
})

describe("token expiry", () => {
  it("reads the JWT exp claim with a five minute margin", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const body = Buffer.from(JSON.stringify({ exp })).toString("base64url")
    const token = `a.${body}.c`
    expect(tokenExpiry(token)).toBe(exp * 1000 - 5 * 60_000)
  })

  it("mints a Cursor SDK API key from a browser JWT and reuses the cached key", async () => {
    process.env.OPENCODEV2_CURSOR_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "opencodev2-cursor-mint-"))
    let calls = 0
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer eyJ.jwt.token")
      return new Response(JSON.stringify({ apiKey: "crsr_minted_123" }), { status: 200 })
    }) as typeof fetch
    const first = await ensureSdkApiKey("eyJ.jwt.token", "refresh-1", fakeFetch)
    const second = await ensureSdkApiKey("eyJ.jwt.token", "refresh-1", fakeFetch)
    expect(first).toBe("crsr_minted_123")
    expect(second).toBe("crsr_minted_123")
    expect(calls).toBe(1)
  })

  it("keeps the refreshed OAuth access token instead of replacing it with a minted SDK key", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      accessToken: "eyJ.refreshed.token",
      refreshToken: "refresh-next",
    }), { status: 200 })) as typeof fetch
    try {
      const tokens = await refreshNativeToken("refresh-1")
      expect(tokens.access).toBe("eyJ.refreshed.token")
      expect(tokens.refresh).toBe("refresh-next")
    } finally {
      globalThis.fetch = original
    }
  })
})
