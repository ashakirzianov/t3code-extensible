import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import { serverBuild } from "../pluginHost.ts";
import * as PluginLoader from "./PluginLoader.ts";

/** Fixture plugins import the host entry by path: vitest serves them, not Node's resolver. */
const HOST_IMPORT = new URL("../pluginHost.ts", import.meta.url).href;

declare global {
  var __pluginLoaderTestEvents: Array<string> | undefined;
}

const events = (): Array<string> => (globalThis.__pluginLoaderTestEvents ??= []);

const layerBase = Layer.mergeAll(
  McpServer.McpServer.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-plugin-loader-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const pluginSource = (
  name: string,
  build: string,
  options: {
    readonly identity?: string;
    readonly builtFor?: string;
    readonly activate?: string;
  } = {},
) => `
import { Context, Effect, HttpServerResponse, McpSchema, McpServer, identity as hostIdentity } from ${JSON.stringify(HOST_IMPORT)};
export const identity = ${options.identity ?? "hostIdentity"};
export const builtFor = ${options.builtFor ?? JSON.stringify(serverBuild)};
const events = globalThis.__pluginLoaderTestEvents;
export const activate = ${
  options.activate ??
  `(host) => Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: "fixture_${name}",
        description: "build ${build}",
        inputSchema: { type: "object", properties: {} },
      }),
      annotations: Context.empty(),
      handle: () => Effect.succeed(new McpSchema.CallToolResult({ content: [{ type: "text", text: "${build}" }] })),
    });
    yield* host.serve((_request, path) => Effect.succeed(HttpServerResponse.text("${build} " + path)));
    events.push("activate ${name} ${build}");
    yield* Effect.addFinalizer(() => Effect.sync(() => { events.push("dispose ${name} ${build}"); }));
  })`
};
`;

const pluginsDir = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.baseDir, "plugins");
});

const writeBuild = (name: string, build: string, source: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(yield* pluginsDir, name, "builds", build);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, "main.mjs"), source);
  });

const pointCurrent = (name: string, build: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.symlink(path.join("builds", build), path.join(yield* pluginsDir, name, "current"));
  });

const readCurrent = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return path.basename(yield* fs.readLink(path.join(yield* pluginsDir, name, "current")));
  });

/** Builds the loader (which loads every `current`) and keeps it alive for the test's scope. */
const startLoader = Effect.gen(function* () {
  const context = yield* Layer.build(PluginLoader.layer);
  return Context.get(context, PluginLoader.PluginLoader);
});

const toolDescription = (name: string) =>
  Effect.map(
    McpServer.McpServer,
    (server) => server.tools.find((entry) => entry.tool.name === name)?.tool.description,
  );

type TestServices =
  | PluginLoader.PluginLoader
  | ServerConfig.ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | McpServer.McpServer;

/** Starts the loader with alpha's `b1` as `current`, then runs the body against it. */
const withAlpha = <E>(body: Effect.Effect<void, E, TestServices>) =>
  Effect.gen(function* () {
    events().length = 0;
    yield* writeBuild("alpha", "b1", pluginSource("alpha", "b1"));
    yield* pointCurrent("alpha", "b1");
    yield* body.pipe(Effect.provideServiceEffect(PluginLoader.PluginLoader, startLoader));
  }).pipe(Effect.scoped, Effect.provide(layerBase));

it.effect("loads each plugin's current build at startup", () =>
  Effect.gen(function* () {
    events().length = 0;
    yield* writeBuild("alpha", "b1", pluginSource("alpha", "b1"));
    yield* pointCurrent("alpha", "b1");
    yield* writeBuild("beta", "b1", pluginSource("beta", "b1"));
    const loader = yield* startLoader;

    const listed = yield* loader.list;
    expect(
      listed.map(({ name, build, status, error }) => ({ name, build, status, error })),
    ).toEqual([
      { name: "alpha", build: "b1", status: "loaded", error: undefined },
      { name: "beta", build: undefined, status: "none", error: undefined },
    ]);
    expect(events()).toEqual(["activate alpha b1"]);
    expect(yield* toolDescription("fixture_alpha")).toBe("build b1");
    expect(loader.route("alpha")).toBeDefined();
    expect(loader.route("beta")).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(layerBase)),
);

it.effect("reload activates the new build, repoints current, then closes the old build", () =>
  withAlpha(
    Effect.gen(function* () {
      const loader = yield* PluginLoader.PluginLoader;
      yield* writeBuild("alpha", "b2", pluginSource("alpha", "b2"));

      const status = yield* loader.reload("alpha", "b2");
      expect(status.build).toBe("b2");
      expect(status.status).toBe("loaded");
      expect(events()).toEqual(["activate alpha b1", "activate alpha b2", "dispose alpha b1"]);
      expect(yield* readCurrent("alpha")).toBe("b2");
      expect(yield* toolDescription("fixture_alpha")).toBe("build b2");

      // The same build id imports afresh.
      yield* loader.reload("alpha", "b2");
      expect(events().slice(3)).toEqual(["activate alpha b2", "dispose alpha b2"]);
    }),
  ),
);

it.effect("a build that fails to import is reported and the old build keeps running", () =>
  withAlpha(
    Effect.gen(function* () {
      const loader = yield* PluginLoader.PluginLoader;
      yield* writeBuild("alpha", "b2", "export const identity = ;");

      const failure = yield* Effect.flip(loader.reload("alpha", "b2"));
      expect(failure._tag).toBe("PluginImportError");
      const [status] = yield* loader.list;
      expect(status?.build).toBe("b1");
      expect(status?.status).toBe("failed");
      expect(status?.error).toContain('build "b2" failed to import');
      expect(events()).toEqual(["activate alpha b1"]);
      expect(yield* readCurrent("alpha")).toBe("b1");
    }),
  ),
);

it.effect("a build with its own identity is refused", () =>
  withAlpha(
    Effect.gen(function* () {
      const loader = yield* PluginLoader.PluginLoader;
      yield* writeBuild(
        "alpha",
        "b2",
        pluginSource("alpha", "b2", { identity: '{ host: "@t3code/plugin-host" }' }),
      );

      const failure = yield* Effect.flip(loader.reload("alpha", "b2"));
      expect(failure._tag).toBe("PluginIdentityError");
      expect(events()).toEqual(["activate alpha b1"]);
      expect((yield* loader.list)[0]?.build).toBe("b1");
    }),
  ),
);

it.effect("a build made for another server build is refused", () =>
  withAlpha(
    Effect.gen(function* () {
      const loader = yield* PluginLoader.PluginLoader;
      yield* writeBuild(
        "alpha",
        "b2",
        pluginSource("alpha", "b2", { builtFor: '{ version: "0.0.0", commit: "abc" }' }),
      );

      const failure = yield* Effect.flip(loader.reload("alpha", "b2"));
      expect(failure._tag).toBe("PluginBuildMismatchError");
      expect(failure.message).toContain("was built for 0.0.0@abc");
      expect(events()).toEqual(["activate alpha b1"]);
      expect((yield* loader.list)[0]?.build).toBe("b1");
    }),
  ),
);

it.effect("a build whose activate fails is closed and the old build keeps running", () =>
  withAlpha(
    Effect.gen(function* () {
      const loader = yield* PluginLoader.PluginLoader;
      yield* writeBuild(
        "alpha",
        "b2",
        pluginSource("alpha", "b2", {
          activate: `() => Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => { events.push("dispose alpha b2"); }));
            return yield* Effect.fail(new Error("boom"));
          })`,
        }),
      );

      const failure = yield* Effect.flip(loader.reload("alpha", "b2"));
      expect(failure._tag).toBe("PluginActivateError");
      expect(events()).toEqual(["activate alpha b1", "dispose alpha b2"]);
      const [status] = yield* loader.list;
      expect(status?.build).toBe("b1");
      expect(status?.error).toContain("boom");
      expect(yield* readCurrent("alpha")).toBe("b1");
    }),
  ),
);

it.effect("reload of an unknown plugin or build fails without touching anything", () =>
  withAlpha(
    Effect.gen(function* () {
      const loader = yield* PluginLoader.PluginLoader;
      expect((yield* Effect.flip(loader.reload("gamma", "b1")))._tag).toBe("PluginNotFoundError");
      expect((yield* Effect.flip(loader.reload("alpha", "b9")))._tag).toBe(
        "PluginBuildNotFoundError",
      );
      expect(events()).toEqual(["activate alpha b1"]);
      expect((yield* loader.list)[0]?.status).toBe("loaded");
    }),
  ),
);
