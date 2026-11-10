import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import type { BackendEvent, BackendRunRequest, CursorBackend } from "../types.js"
import { promptWithToolResults } from "../types.js"
import { SdkBackend, type SdkBackendOptions } from "../sdk.js"
import { encodeConnectFrames, encodeRunRequest, decodeConnectData, stringsInProtobuf, toolCallFromText } from "./proto.js"
import { nodeBinary } from "../spawn.js"
import { mapCursorTool } from "../../proxy/tools.js"
import { log } from "../../util/log.js"

function bridgeScript(): string {
  return fileURLToPath(new URL("./h2-bridge.mjs", import.meta.url))
}

async function* connectRun(request: BackendRunRequest, accessToken: string): AsyncIterable<BackendEvent> {
  const child = spawn(nodeBinary(), [bridgeScript()], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: process.env,
  }) as ChildProcessWithoutNullStreams
  const lines = createInterface({ input: child.stdout })
  const prompt = promptWithToolResults(request.prompt, request.toolResults)
  const body = encodeConnectFrames(encodeRunRequest(request.model, prompt, {
    modelParams: request.modelParams,
    tools: request.tools,
    toolResults: request.toolResults,
  }))
  child.stdin.write(JSON.stringify({
    type: "request",
    id: "run",
    path: "/agent.v1.AgentService/Run",
    authorization: `Bearer ${accessToken}`,
    body: body.toString("base64"),
  }) + "\n")
  const onAbort = () => child.kill()
  request.signal.addEventListener("abort", onAbort, { once: true })
  try {
    for await (const line of lines) {
      const event = JSON.parse(line) as { type: string; message?: string; data?: string; status?: number }
      if (event.type === "error") {
        yield { type: "error", message: event.message || "Cursor Connect request failed" }
        return
      }
      if (event.type === "data" && event.data) {
        const payload = Buffer.from(event.data, "base64")
        const frames = decodeConnectData(payload)
        const texts = frames.flatMap((frame) => stringsInProtobuf(frame))
        if (texts.length === 0 && event.status && event.status >= 400) {
          yield { type: "error", message: `Cursor Connect returned HTTP ${event.status}` }
          return
        }
        const advertised = new Set(request.tools.map((tool) => tool.name))
        for (const text of texts) {
          const call = toolCallFromText(text)
          if (!call) {
            yield { type: "text", text }
            continue
          }
          yield {
            type: "tool_call",
            id: call.id,
            name: mapCursorTool(call.name, advertised) || call.name,
            arguments: call.arguments,
          }
          return
        }
      }
      if (event.type === "end") {
        yield { type: "done" }
        return
      }
    }
    yield { type: "error", message: "Cursor Connect bridge closed" }
  } finally {
    request.signal.removeEventListener("abort", onAbort)
    child.kill()
  }
}

/** OAuth access-token backend. Uses the SDK unless CURSOR_NATIVE_TRANSPORT=connect. */
export class NativeBackend implements CursorBackend {
  readonly id = "native" as const
  private readonly sdk: SdkBackend

  constructor(private readonly accessToken: () => Promise<string>, options?: SdkBackendOptions) {
    this.sdk = new SdkBackend(accessToken, options)
  }

  listModels() {
    return this.sdk.listModels()
  }

  warmUp(cwd: string) {
    return this.sdk.warmUp(cwd)
  }

  async *run(request: BackendRunRequest): AsyncIterable<BackendEvent> {
    if (process.env.CURSOR_NATIVE_TRANSPORT === "connect") {
      log("info", "native connect run", { model: request.model })
      yield* connectRun(request, await this.accessToken())
      return
    }
    yield* this.sdk.run(request)
  }

  async dispose(): Promise<void> {
    await this.sdk.dispose()
  }
}
