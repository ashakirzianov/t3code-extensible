/**
 * What an in-process plugin may import. This file is a second bundle entry,
 * `dist/pluginHost.mjs`, that shares its chunks with `dist/bin.mjs`, so a
 * plugin built with `@t3code/plugin-host` external gets the server's own
 * module instances. See docs/internals/plugins.md.
 */
export * as Cause from "effect/Cause";
export * as Context from "effect/Context";
export * as Effect from "effect/Effect";
export * as Exit from "effect/Exit";
export * as Fiber from "effect/Fiber";
export * as Layer from "effect/Layer";
export * as Option from "effect/Option";
export * as Result from "effect/Result";
export * as Schema from "effect/Schema";
export * as Scope from "effect/Scope";
export * as Stream from "effect/Stream";
export { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
// A plugin registers its tools straight on the server's McpServer, by design: it is fully
// trusted and may read the caller from McpInvocationContext itself (McpToolAccess's
// toolkit checks do not run for a plugin's tool).
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- the plugin surface re-exports it.
export { McpSchema, McpServer } from "effect/ai";

export * as ServerConfig from "./config.ts";
export * as McpInvocationContext from "./mcp/McpInvocationContext.ts";
export * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
export * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
export * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
export type { PluginHost, PluginRouteHandler } from "./plugins/PluginLoader.ts";

import packageJson from "../package.json" with { type: "json" };

declare const __T3CODE_BUILD_COMMIT__: string | undefined;

/**
 * The server build a plugin was built against. A plugin's build script writes
 * the same shape to its `builtFor` export; the loader refuses a plugin built
 * for another version, or another commit when both sides know theirs.
 */
export interface ServerBuild {
  readonly version: string;
  readonly commit: string | undefined;
}

export const serverBuild: ServerBuild = {
  version: packageJson.version,
  commit: typeof __T3CODE_BUILD_COMMIT__ === "string" ? __T3CODE_BUILD_COMMIT__ : undefined,
};

/**
 * Proof that a plugin shares this module graph. A plugin re-exports this as
 * `identity`; one that bundled its own Effect would otherwise resolve the
 * host's services silently and run on a second runtime.
 */
export const hostIdentity: { readonly host: "@t3code/plugin-host" } = Object.freeze({
  host: "@t3code/plugin-host",
});
export const identity = hostIdentity;
