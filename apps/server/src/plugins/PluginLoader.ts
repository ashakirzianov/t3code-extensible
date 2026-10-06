/**
 * Loads in-process plugins from `<baseDir>/plugins/<name>/builds/<build>/main.mjs`
 * and swaps them on request. A plugin's `activate(host)` runs with the server's
 * whole context in a scope this loader owns; a reload imports the new build
 * first, points `current` at it on success, then closes the old build's scope.
 * See docs/internals/plugins.md.
 */
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

import type { AuthEnvironmentScope } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { McpServer } from "effect/ai";
import type { HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import { hostIdentity, type ServerBuild, serverBuild } from "../pluginHost.ts";

/** The bare specifier a plugin build leaves external; resolved to the host entry here. */
export const HOST_SPECIFIER = "@t3code/plugin-host";

/** Plugin names and build ids are single path segments. */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class PluginNotFoundError extends Schema.TaggedError<PluginNotFoundError>()(
  "PluginNotFoundError",
  { name: Schema.String },
) {
  override get message(): string {
    return `No plugin named "${this.name}" is installed.`;
  }
}

export class PluginBuildNotFoundError extends Schema.TaggedError<PluginBuildNotFoundError>()(
  "PluginBuildNotFoundError",
  { name: Schema.String, build: Schema.String },
) {
  override get message(): string {
    return `Plugin "${this.name}" has no build "${this.build}".`;
  }
}

export class PluginImportError extends Schema.TaggedError<PluginImportError>()(
  "PluginImportError",
  { name: Schema.String, build: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Plugin "${this.name}" build "${this.build}" failed to import.`;
  }
}

export class PluginIdentityError extends Schema.TaggedError<PluginIdentityError>()(
  "PluginIdentityError",
  { name: Schema.String, build: Schema.String },
) {
  override get message(): string {
    return `Plugin "${this.name}" build "${this.build}" does not share the host's modules: it must re-export identity from ${HOST_SPECIFIER} and leave that specifier external.`;
  }
}

export class PluginBuildMismatchError extends Schema.TaggedError<PluginBuildMismatchError>()(
  "PluginBuildMismatchError",
  {
    name: Schema.String,
    build: Schema.String,
    builtFor: Schema.String,
    serverBuild: Schema.String,
  },
) {
  override get message(): string {
    return `Plugin "${this.name}" build "${this.build}" was built for ${this.builtFor}; this server is ${this.serverBuild}.`;
  }
}

export class PluginActivateError extends Schema.TaggedError<PluginActivateError>()(
  "PluginActivateError",
  { name: Schema.String, build: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Plugin "${this.name}" build "${this.build}" failed to activate.`;
  }
}

export type PluginLoadError =
  | PluginBuildNotFoundError
  | PluginImportError
  | PluginIdentityError
  | PluginBuildMismatchError
  | PluginActivateError;

/** The error with its underlying cause, for the reload answer and the status list. */
export const describeLoadError = (error: PluginLoadError): string =>
  "cause" in error ? `${error.message} ${describeCause(error.cause)}` : error.message;

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

const describeBuild = (build: ServerBuild): string =>
  `${build.version}@${build.commit ?? "unknown-commit"}`;

export interface PluginStatus {
  readonly name: string;
  /** The build that is running, if any. */
  readonly build: string | undefined;
  /** "failed" describes the last attempt; a previous build may still be running. */
  readonly status: "loaded" | "failed" | "none";
  readonly error: string | undefined;
  readonly loadedAt: string | undefined;
}

/**
 * Answers `/api/plugins/<name>/<path>`; a failure or defect becomes a 500. The
 * session already holds `orchestration:read` for GET and HEAD and `access:write`
 * otherwise; `scopes` are all of it, for the handler to gate further.
 */
export type PluginRouteHandler = (
  request: HttpServerRequest.HttpServerRequest,
  path: string,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) => Effect.Effect<HttpServerResponse.HttpServerResponse>;

/** What `activate` receives. The activation effect already runs with `context` provided. */
export interface PluginHost {
  readonly name: string;
  readonly build: string;
  readonly context: Context.Context<McpServer.McpServer>;
  /** Serve `/api/plugins/<name>/<path>` for this build; released with the build's scope. */
  readonly serve: (handler: PluginRouteHandler) => Effect.Effect<void, never, Scope.Scope>;
}

interface PluginModule {
  readonly identity?: unknown;
  readonly builtFor?: unknown;
  readonly activate?: unknown;
}

interface RunningBuild {
  readonly build: string;
  readonly scope: Scope.Closeable;
  readonly loadedAt: string;
}

interface PluginRecord {
  running: RunningBuild | undefined;
  lastError: string | undefined;
}

export class PluginLoader extends Context.Service<
  PluginLoader,
  {
    readonly list: Effect.Effect<ReadonlyArray<PluginStatus>>;
    readonly reload: (
      name: string,
      build: string,
    ) => Effect.Effect<PluginStatus, PluginNotFoundError | PluginLoadError>;
    /** The route handler of the plugin's running build, if it registered one. */
    readonly route: (name: string) => PluginRouteHandler | undefined;
  }
>()("t3/plugins/PluginLoader") {}

const isServerBuild = (value: unknown): value is ServerBuild =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { version?: unknown }).version === "string" &&
  ["string", "undefined"].includes(typeof (value as { commit?: unknown }).commit);

/** Same version, and the same commit when both sides know theirs. */
const isCompatibleBuild = (builtFor: ServerBuild): boolean =>
  builtFor.version === serverBuild.version &&
  (builtFor.commit === undefined ||
    serverBuild.commit === undefined ||
    builtFor.commit === serverBuild.commit);

/** The host entry next to this module in the bundle, or the source in a dev run. */
const resolveHostModuleUrl = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  for (const candidate of ["./pluginHost.mjs", "../pluginHost.mjs", "../pluginHost.ts"]) {
    const url = new URL(candidate, import.meta.url);
    if (yield* fs.exists(NodeURL.fileURLToPath(url)).pipe(Effect.orElseSucceed(() => false))) {
      return url.href;
    }
  }
  return undefined;
});

/**
 * What a plugin's `activate` may return. The channels are nominal: a plugin is
 * JavaScript, and whatever it fails with is caught as a cause by the loader.
 */
const isActivationEffect = (
  value: unknown,
): value is Effect.Effect<unknown, Error, Scope.Scope | McpServer.McpServer> =>
  Effect.isEffect(value);

let hostResolutionRegistered = false;

/** Maps the bare specifier to the host entry for every module Node loads from now on. */
const registerHostResolution = (hostModuleUrl: string) => {
  if (hostResolutionRegistered) return;
  hostResolutionRegistered = true;
  NodeModule.registerHooks({
    resolve: (specifier, context, nextResolve) =>
      specifier === HOST_SPECIFIER
        ? { url: hostModuleUrl, shortCircuit: true }
        : nextResolve(specifier, context),
  });
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Everything the server provided to this layer, for the plugins to run with.
  const context = yield* Effect.context<McpServer.McpServer>();
  const mutex = yield* Semaphore.make(1);
  const pluginsDir = path.join(config.baseDir, "plugins");
  const records = new Map<string, PluginRecord>();
  const routes = new Map<string, PluginRouteHandler>();
  let importCount = 0;

  const hostModuleUrl = yield* resolveHostModuleUrl;
  if (hostModuleUrl === undefined) {
    yield* Effect.logWarning("plugin host entry not found; plugins cannot import it", {
      loader: import.meta.url,
    });
  } else {
    registerHostResolution(hostModuleUrl);
  }

  const record = (name: string): PluginRecord => {
    let existing = records.get(name);
    if (existing === undefined) {
      existing = { running: undefined, lastError: undefined };
      records.set(name, existing);
    }
    return existing;
  };

  const status = (name: string): PluginStatus => {
    const entry = records.get(name);
    return {
      name,
      build: entry?.running?.build,
      status:
        entry?.lastError !== undefined
          ? "failed"
          : entry?.running !== undefined
            ? "loaded"
            : "none",
      error: entry?.lastError,
      loadedAt: entry?.running?.loadedAt,
    };
  };

  const isDirectory = (target: string) =>
    fs.stat(target).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const installedNames = fs.readDirectory(pluginsDir).pipe(
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
    Effect.flatMap((entries) =>
      Effect.filter(
        entries.filter((entry) => SEGMENT_PATTERN.test(entry)),
        (entry) => isDirectory(path.join(pluginsDir, entry)),
      ),
    ),
  );

  const runActivate = (
    activate: (host: PluginHost) => unknown,
    host: PluginHost,
    scope: Scope.Closeable,
  ) =>
    Effect.gen(function* () {
      const activated = activate(host);
      if (isActivationEffect(activated)) {
        yield* activated.pipe(Scope.provide(scope), Effect.provide(context));
        return;
      }
      const resolved = yield* Effect.promise(() => Promise.resolve(activated));
      if (typeof resolved === "function") {
        const dispose = resolved as () => unknown;
        yield* Scope.addFinalizer(
          scope,
          Effect.promise(() => Promise.resolve(dispose())).pipe(Effect.ignore),
        );
      }
    });

  const loadBuild = Effect.fn("PluginLoader.loadBuild")(function* (name: string, build: string) {
    const mainPath = path.join(pluginsDir, name, "builds", build, "main.mjs");
    if (
      !SEGMENT_PATTERN.test(build) ||
      !(yield* fs.exists(mainPath).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return yield* new PluginBuildNotFoundError({ name, build });
    }
    // A fresh URL each time, so re-importing the same build id bypasses the module cache.
    importCount += 1;
    const url = `${NodeURL.pathToFileURL(mainPath).href}?load=${importCount}`;
    const module = yield* Effect.tryPromise({
      try: () => import(url) as Promise<PluginModule>,
      catch: (cause) => new PluginImportError({ name, build, cause }),
    });
    if (module.identity !== hostIdentity) {
      return yield* new PluginIdentityError({ name, build });
    }
    if (!isServerBuild(module.builtFor) || !isCompatibleBuild(module.builtFor)) {
      return yield* new PluginBuildMismatchError({
        name,
        build,
        builtFor: isServerBuild(module.builtFor)
          ? describeBuild(module.builtFor)
          : "an unknown build (no builtFor export)",
        serverBuild: describeBuild(serverBuild),
      });
    }
    const activate = module.activate;
    if (typeof activate !== "function") {
      return yield* new PluginActivateError({
        name,
        build,
        cause: new Error("main.mjs does not export activate"),
      });
    }
    const scope = yield* Scope.make();
    const host: PluginHost = {
      name,
      build,
      context,
      serve: (handler) =>
        Effect.gen(function* () {
          routes.set(name, handler);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (routes.get(name) === handler) routes.delete(name);
            }),
          );
        }),
    };
    yield* runActivate(activate as (host: PluginHost) => unknown, host, scope).pipe(
      Effect.catchCause((cause) =>
        Scope.close(scope, Exit.void).pipe(
          Effect.andThen(new PluginActivateError({ name, build, cause: Cause.squash(cause) })),
        ),
      ),
    );
    const loadedAt = DateTime.formatIso(yield* DateTime.now);
    return { build, scope, loadedAt } satisfies RunningBuild;
  });

  const pointCurrent = (name: string, build: string) =>
    Effect.gen(function* () {
      const currentPath = path.join(pluginsDir, name, "current");
      const tmpPath = `${currentPath}.tmp`;
      yield* fs.remove(tmpPath).pipe(Effect.ignore);
      yield* fs.symlink(path.join("builds", build), tmpPath);
      yield* fs.rename(tmpPath, currentPath);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("plugin current link not updated", { name, build, cause }),
      ),
    );

  const swapIn = (name: string, running: RunningBuild) =>
    Effect.gen(function* () {
      const entry = record(name);
      const previous = entry.running;
      entry.running = running;
      entry.lastError = undefined;
      if (previous !== undefined) {
        yield* Scope.close(previous.scope, Exit.void);
      }
      yield* Effect.logInfo("plugin loaded", { name, build: running.build });
    });

  const noteFailure = (name: string, error: PluginLoadError) =>
    Effect.gen(function* () {
      const described = describeLoadError(error);
      record(name).lastError = described;
      yield* Effect.logWarning("plugin failed to load", {
        name,
        build: error.build,
        error: described,
      });
    });

  const reload: PluginLoader["Service"]["reload"] = (name, build) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        if (!SEGMENT_PATTERN.test(name) || !(yield* isDirectory(path.join(pluginsDir, name)))) {
          return yield* new PluginNotFoundError({ name });
        }
        // A request naming a build that does not exist is a 404, not a failed plugin.
        const running = yield* loadBuild(name, build).pipe(
          Effect.tapError((error) =>
            error._tag === "PluginBuildNotFoundError" ? Effect.void : noteFailure(name, error),
          ),
        );
        yield* pointCurrent(name, build);
        yield* swapIn(name, running);
        return status(name);
      }),
    );

  const loadCurrent = (name: string) =>
    Effect.gen(function* () {
      const target = yield* fs.readLink(path.join(pluginsDir, name, "current")).pipe(Effect.option);
      if (target._tag === "None") {
        record(name);
        return;
      }
      const build = path.basename(target.value);
      const running = yield* loadBuild(name, build).pipe(
        Effect.tapError((error) => noteFailure(name, error)),
      );
      yield* swapIn(name, running);
    }).pipe(Effect.ignore);

  const list = Effect.gen(function* () {
    const names = new Set([...(yield* installedNames), ...records.keys()]);
    return [...names].sort().map(status);
  });

  yield* Effect.forEach(yield* installedNames, loadCurrent, { discard: true });
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      records.values(),
      (entry) =>
        entry.running === undefined ? Effect.void : Scope.close(entry.running.scope, Exit.void),
      { discard: true },
    ),
  );

  return PluginLoader.of({ list, reload, route: (name) => routes.get(name) });
});

export const layer = Layer.effect(PluginLoader, make);
