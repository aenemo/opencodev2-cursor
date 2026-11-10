import type { Plugin as PluginNamespace } from "@opencode/plugin"
import { Plugin } from "@opencode/plugin"
import { AgentCliBackend } from "./backends/agent-cli.js"
import { SdkBackend, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS } from "./backends/sdk.js"
import { DEFAULT_MODELS_CACHE_TTL_MS } from "./backends/model-cache.js"
import { NativeBackend } from "./backends/native/backend.js"
import { ensureSdkApiKey } from "./backends/native/auth.js"
import { registerIntegrations, resolveAuth } from "./plugin/auth.js"
import { CURSOR_VARIANT_HEADER, labelOtherProviders, modelsForPublish, noteDiscovered, publishProvider, publishedModels, selectModel } from "./plugin/catalog.js"
import { startSharedProxy, type RunningProxy } from "./proxy/server.js"
import { log } from "./util/log.js"

function positiveMs(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const OpenCodeV2Cursor = Plugin.define({
  id: "opencodev2-cursor",
  async setup(ctx) {
    await registerIntegrations(ctx)
    const state: { port: number; token: string } = {
      port: 0,
      token: "",
    }
    const timeouts = {
      idleTimeoutMs: positiveMs(ctx.options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS),
      turnTimeoutMs: positiveMs(ctx.options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS),
      modelsCacheTtlMs: positiveMs(ctx.options.modelsCacheTtlMs, DEFAULT_MODELS_CACHE_TTL_MS),
    }
    const cli = new AgentCliBackend()
    const sdk = new SdkBackend(async () => {
      const auth = await resolveAuth(ctx)
      const key = auth?.apiKey || auth?.accessToken
      if (!key) throw new Error("Connect Cursor with an API key, or set CURSOR_API_KEY, before using the SDK backend.")
      return ensureSdkApiKey(key, auth?.refreshToken)
    }, timeouts)
    const native = new NativeBackend(async () => {
      const auth = await resolveAuth(ctx)
      if (!auth?.accessToken) throw new Error("Use Cursor account (native OAuth) before the native backend.")
      // Connect-RPC wants the OAuth access token. The SDK wants a minted crsr_ user API key.
      if (process.env.CURSOR_NATIVE_TRANSPORT === "connect") return auth.accessToken
      return ensureSdkApiKey(auth.accessToken, auth.refreshToken)
    }, timeouts)
    const proxy: RunningProxy = await startSharedProxy({
      getAuth: () => resolveAuth(ctx),
      backends: { cli, sdk, native },
      fallbackDirectory: () => ctx.location.directory,
      models: () => publishedModels(),
      selectModel,
      idleTimeoutMs: timeouts.idleTimeoutMs,
      turnTimeoutMs: timeouts.turnTimeoutMs,
    })
    state.port = proxy.port
    state.token = proxy.token
    await publishProvider(ctx, state)
    if (ctx.options.labelAllProviders === true) await ctx.model.transform((editor) => labelOtherProviders(editor))

    const warm = async () => {
      const auth = await resolveAuth(ctx)
      if (!auth || auth.kind === "cli") return
      const started = Date.now()
      try {
        if (auth.kind === "native") await native.warmUp(ctx.location.directory)
        else await sdk.warmUp(ctx.location.directory)
        log("info", "cursor backend warm-up complete", { kind: auth.kind, ms: Date.now() - started })
      } catch (error) {
        log("warn", "cursor backend warm-up failed", error instanceof Error ? error.message : error)
      }
    }

    const refresh = async () => {
      const auth = await resolveAuth(ctx)
      try {
        // SDK/native warmUp lists models and prewarms the workspace executor in one worker round-trip.
        const next = !auth || auth.kind === "cli"
          ? await cli.listModels()
          : auth.kind === "native"
            ? await native.warmUp(ctx.location.directory)
            : await sdk.warmUp(ctx.location.directory)
        if (noteDiscovered(next)) log("info", "cursor models updated", modelsForPublish().map((model) => model.id))
        else log("info", "cursor model discovery kept the current catalog", modelsForPublish().map((model) => model.id))
      } catch (error) {
        log("warn", "model discovery failed", error instanceof Error ? error.message : error)
        void warm()
      }
      await ctx.provider.reload()
    }
    void refresh()

    await ctx.session.hook(
      "model.request",
      async (event) => {
        let directory: string = ctx.location.directory
        try {
          const session = await ctx.session.get({ sessionID: event.sessionID })
          const located = session as { directory?: string; location?: { directory?: string } }
          directory = located.location?.directory || located.directory || directory
        } catch (error) {
          log("warn", "session directory lookup failed", error instanceof Error ? error.message : error)
        }
        event.headers["x-opencode-directory"] = encodeURIComponent(directory)
        event.headers["x-opencodev2-cursor-session"] = String(event.sessionID)
        if (event.model.variant) event.headers[CURSOR_VARIANT_HEADER] = String(event.model.variant)
        event.headers.authorization = `Bearer ${state.token}`
        event.baseURL = `http://127.0.0.1:${state.port}/v1`
      },
      { providerID: "cursor" },
    )

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = (event as { type: string }).type
          if (type.includes("connection") || type.includes("credential")) void refresh()
        }
      } catch {
        // Unsubscribing ends the loop.
      }
    })()

    return async () => {
      controller.abort()
      await sdk.dispose()
      await native.dispose()
      await proxy.close()
    }
  },
})

export default OpenCodeV2Cursor

export type { PluginNamespace }
