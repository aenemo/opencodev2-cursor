import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { FALLBACK_MODELS } from "./types.js"
import { createModelCache } from "./model-cache.js"

const sample = [{ id: "grok-4.7", name: "Grok 4.7", contextWindow: 256000, maxTokens: 32000 }]

describe("model list cache", () => {
  it("shares one in-flight request between concurrent callers", async () => {
    let calls = 0
    let release!: (models: typeof sample) => void
    const gate = new Promise<typeof sample>((resolve) => {
      release = resolve
    })
    const cache = createModelCache({ file: path.join(os.tmpdir(), "missing-models.json"), ttlMs: 60_000 })
    const first = cache.load(() => {
      calls += 1
      return gate
    })
    const second = cache.load(() => {
      calls += 1
      return gate
    })
    expect(calls).toBe(1)
    release(sample)
    await expect(Promise.all([first, second])).resolves.toEqual([sample, sample])
    expect(calls).toBe(1)
  })

  it("falls back to the cached list when Cursor rate limits get_models", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodev2-cursor-models-"))
    const file = path.join(dir, "models.json")
    fs.writeFileSync(file, JSON.stringify(sample))
    const old = new Date(Date.now() - 60 * 60 * 1000)
    fs.utimesSync(file, old, old)
    let calls = 0
    const cache = createModelCache({ file, ttlMs: 1_000, now: () => Date.now() })
    const models = await cache.load(async () => {
      calls += 1
      throw new Error("exceeded the rate limit of 30 requests per minute for the get_models endpoint")
    })
    expect(models).toEqual(sample)
    const again = await cache.load(async () => {
      calls += 1
      throw new Error("rate limit")
    })
    expect(again).toEqual(sample)
    expect(calls).toBe(1)
  })

  it("uses FALLBACK_MODELS when a rate limit arrives with no cache", async () => {
    const cache = createModelCache({
      file: path.join(os.tmpdir(), "does-not-exist-models.json"),
      ttlMs: 60_000,
    })
    const models = await cache.load(async () => {
      throw new Error("rate limit")
    })
    expect(models).toEqual(FALLBACK_MODELS)
  })
})
