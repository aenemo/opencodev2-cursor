export interface CursorModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /** Cursor's default variant within its model family, when the SDK reports one. */
  isDefault?: boolean
}

export type BackendEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "done"; text?: string }
  | { type: "error"; message: string }
  /** The Cursor run is still open, but it has not produced model output. Not shown to the user. */
  | { type: "keepalive" }

export interface ToolSpec {
  name: string
  description?: string
  parameters?: unknown
}

export interface BackendRunRequest {
  model: string
  /** Cursor SDK model params such as optimize_for for Auto Router. */
  modelParams?: Array<{ id: string; value: string }>
  /** cursor-agent --model string, including bracket params when needed. */
  cliModel?: string
  prompt: string
  /** Latest user message only, used when continuing an existing stateful SDK agent. */
  lastUserPrompt?: string
  cwd: string
  tools: ToolSpec[]
  toolResults?: Array<{ id: string; content: string }>
  continuation?: boolean
  sessionKey: string
  signal: AbortSignal
}

export interface CursorBackend {
  readonly id: "cli" | "sdk" | "native"
  listModels(): Promise<CursorModel[]>
  run(request: BackendRunRequest): AsyncIterable<BackendEvent>
  /** Start the long-lived worker and load the SDK so the first chat turn is not cold. */
  /** Prefetch models and prewarm the local workspace executor. Returns the model list when available. */
  warmUp?(cwd: string): Promise<CursorModel[]>
  dispose?(): Promise<void>
}

/** Appends tool results the way a stateless backend must, because it has no live tool channel. */
export function promptWithToolResults(
  prompt: string,
  toolResults?: ReadonlyArray<{ id: string; content: string }>,
): string {
  if (!toolResults?.length) return prompt
  return `${prompt}\n\nTool results:\n${toolResults.map((result) => `${result.id}: ${result.content}`).join("\n")}`
}

export interface AuthMaterial {
  kind: "cli" | "api-key" | "native"
  apiKey?: string
  accessToken?: string
  refreshToken?: string
}

/** Advertised to OpenCode. Cursor's catalog does not include a context size. */
export const MODEL_CONTEXT_WINDOW = 256000
export const MODEL_MAX_TOKENS = 32000

export const FALLBACK_MODELS: CursorModel[] = [
  { id: "auto-cursor-balanced", name: "Auto-Cursor-Balanced", contextWindow: MODEL_CONTEXT_WINDOW, maxTokens: MODEL_MAX_TOKENS },
  { id: "auto-cursor-cost", name: "Auto-Cursor-Cost", contextWindow: MODEL_CONTEXT_WINDOW, maxTokens: MODEL_MAX_TOKENS },
  { id: "auto-cursor-intelligence", name: "Auto-Cursor-Intelligence", contextWindow: MODEL_CONTEXT_WINDOW, maxTokens: MODEL_MAX_TOKENS },
  { id: "auto", name: "Auto-Cursor-Balanced", contextWindow: MODEL_CONTEXT_WINDOW, maxTokens: MODEL_MAX_TOKENS },
  { id: "composer-2.5", name: "Composer 2.5", contextWindow: MODEL_CONTEXT_WINDOW, maxTokens: MODEL_MAX_TOKENS },
  { id: "composer-2", name: "Composer 2", contextWindow: MODEL_CONTEXT_WINDOW, maxTokens: MODEL_MAX_TOKENS },
]
