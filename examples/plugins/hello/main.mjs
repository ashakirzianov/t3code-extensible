/**
 * The sample plugin: one MCP tool, `hello_whoami`, answering with the calling
 * thread, and `GET /api/plugins/hello/ping`. `pnpm build [build-id]` bundles it
 * into `dist/<build-id>/main.mjs`; copy that directory to
 * `<home>/plugins/hello/builds/<build-id>/` and reload. See docs/internals/plugins.md.
 */
import {
  Context,
  Effect,
  HttpServerResponse,
  McpInvocationContext,
  McpSchema,
  McpServer,
  identity,
} from "@t3code/plugin-host";

// The loader refuses a plugin without these: the host's identity, and the server build it was made for.
export { identity };
export const builtFor = __BUILT_FOR__;

export const activate = (host) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    // oxlint-disable-next-line t3code/no-raw-mcp-registration -- a plugin registers straight on the host's server; it is fully trusted.
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: "hello_whoami",
        description: "Answers with the thread that called it.",
        inputSchema: { type: "object", properties: {} },
      }),
      annotations: Context.empty(),
      handle: () =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(
            fiber.context,
            McpInvocationContext.McpInvocationContext,
          );
          return Effect.succeed(
            new McpSchema.CallToolResult({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    threadId: invocation.thread?.threadId ?? null,
                    client: invocation.client?.label ?? null,
                    build: host.build,
                  }),
                },
              ],
            }),
          );
        }),
    });

    yield* host.serve((_request, path) =>
      Effect.succeed(
        path === "/ping"
          ? HttpServerResponse.jsonUnsafe({ plugin: host.name, build: host.build, pong: true })
          : HttpServerResponse.empty({ status: 404 }),
      ),
    );

    yield* Effect.addFinalizer(() =>
      Effect.logInfo("hello plugin unloaded", { build: host.build }),
    );
    yield* Effect.logInfo("hello plugin loaded", { build: host.build });
  });
