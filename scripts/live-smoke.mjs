import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

const port = Number(process.argv[2])
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Usage: node scripts/live-smoke.mjs <local-proxy-port>")
const streaming = process.argv.includes("--stream")
const cwd = process.cwd()
const session = `live-smoke-${randomUUID()}`
const messages = [{ role: "user", content: "Read package.json using the read tool exactly once. Then reply with only LIVE_OK followed by the package name and version. Do not edit files or use any other tools." }]
const tools = [{ type: "function", function: {
  name: "read",
  description: "Read package.json from the current project. This smoke test allows no other files.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
} }]
for (let step = 0; step < 4; step++) {
  const started = Date.now()
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-directory": encodeURIComponent(cwd),
      "x-opencodev2-cursor-session": session,
      "x-opencodev2-cursor-variant": "low-fast",
    },
    body: JSON.stringify({ model: "grok-4.7[context=256k]", stream: streaming, messages, tools }),
    signal: AbortSignal.timeout(110000),
  })
  let result
  if (streaming && response.ok) {
    const text = await response.text()
    const message = { content: "", tool_calls: [] }
    let finish_reason
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue
      const chunk = JSON.parse(line.slice(6))
      if (chunk.error) throw new Error(`Streaming error: ${JSON.stringify(chunk.error)}`)
      const choice = chunk.choices?.[0]
      if (!choice) continue
      finish_reason = choice.finish_reason ?? finish_reason
      message.content += choice.delta?.content ?? ""
      for (const call of choice.delta?.tool_calls ?? []) {
        const current = message.tool_calls[call.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } }
        current.id = call.id ?? current.id
        current.function.name += call.function?.name ?? ""
        current.function.arguments += call.function?.arguments ?? ""
      }
    }
    if (!text.includes("data: [DONE]")) throw new Error("Streaming response did not finish")
    result = { choices: [{ message, finish_reason }] }
  } else {
    result = await response.json()
  }
  if (!response.ok || result.error) throw new Error(`Proxy error: ${JSON.stringify(result.error ?? response.status)}`)
  const message = result.choices?.[0]?.message
  if (!message) throw new Error("Missing completion message")
  console.log(JSON.stringify({ port, streaming, step, ms: Date.now() - started, finish: result.choices[0].finish_reason, toolNames: message.tool_calls?.map((call) => call.function.name), text: message.content }))
  messages.push({ ...message, role: "assistant" })
  if (!message.tool_calls?.length) {
    if (step === 0 || !message.content?.includes("LIVE_OK")) throw new Error("Expected a tool call followed by LIVE_OK")
    console.log(JSON.stringify({ status: "passed", port, session }))
    process.exit(0)
  }
  for (const call of message.tool_calls) {
    if (call.function.name !== "read") throw new Error("Unexpected tool name")
    const args = JSON.parse(call.function.arguments)
    const requested = args.path ?? args.filePath ?? args.file_path
    if (typeof requested !== "string" || path.resolve(cwd, requested).toLowerCase() !== path.join(cwd, "package.json").toLowerCase()) throw new Error(`Read target is not package.json: ${JSON.stringify(args)}`)
    messages.push({ role: "tool", tool_call_id: call.id, content: fs.readFileSync(path.join(cwd, "package.json"), "utf8") })
  }
}
throw new Error("Tool loop exceeded smoke-test limit")
