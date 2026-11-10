import fs from "node:fs"
import path from "node:path"
import { FALLBACK_MODELS, type CursorModel } from "./types.js"
import { cacheDir } from "../util/paths.js"

export const DEFAULT_MODELS_CACHE_TTL_MS = 10 * 60 * 1000

export function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /rate limit/i.test(message)
}

function isModel(value: unknown): value is CursorModel {
  if (!value || typeof value !== "object") return false
  const model = value as CursorModel
  return typeof model.id === "string" && model.id.length > 0 && typeof model.name === "string"
    && typeof model.contextWindow === "number" && typeof model.maxTokens === "number"
}

export interface ModelCache {
  load(fetchModels: () => Promise<CursorModel[]>): Promise<CursorModel[]>
}

/** Share one in-flight model list, and skip Cursor when models.json is still inside the time limit. */
export function createModelCache(options?: { ttlMs?: number; file?: string; now?: () => number; fallback?: CursorModel[] }): ModelCache {
  const ttlMs = options?.ttlMs ?? DEFAULT_MODELS_CACHE_TTL_MS
  const file = options?.file ?? path.join(cacheDir(), "models.json")
  const now = options?.now ?? (() => Date.now())
  const fallback = options?.fallback ?? FALLBACK_MODELS
  let memory: { at: number; models: CursorModel[] } | undefined
  let backoffUntil = 0
  let flight: Promise<CursorModel[]> | undefined

  function readDisk(allowStale: boolean): CursorModel[] | undefined {
    try {
      const stat = fs.statSync(file)
      if (!allowStale && now() - stat.mtimeMs > ttlMs) return undefined
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
      if (!Array.isArray(parsed)) return undefined
      const models = parsed.filter(isModel)
      return models.length > 0 ? models : undefined
    } catch {
      return undefined
    }
  }

  function remember(models: CursorModel[]): CursorModel[] {
    memory = { at: now(), models }
    return models
  }

  async function fetchAndStore(fetchModels: () => Promise<CursorModel[]>): Promise<CursorModel[]> {
    try {
      const models = await fetchModels()
      backoffUntil = 0
      return remember(models.length > 0 ? models : readDisk(true) ?? fallback)
    } catch (error) {
      if (!isRateLimit(error)) throw error
      backoffUntil = now() + ttlMs
      return readDisk(true) ?? memory?.models ?? fallback
    }
  }

  return {
    load(fetchModels) {
      const at = now()
      if (backoffUntil > at) return Promise.resolve(readDisk(true) ?? memory?.models ?? fallback)
      if (memory && at - memory.at <= ttlMs) return Promise.resolve(memory.models)
      const disk = readDisk(false)
      if (disk) return Promise.resolve(remember(disk))
      flight ??= fetchAndStore(fetchModels).finally(() => {
        flight = undefined
      })
      return flight
    },
  }
}
