/**
 * The plugin surface over HTTP: the installed list, the explicit reload, and
 * the running builds' own routes, all behind the environment's session auth.
 */
import {
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as PluginLoader from "./PluginLoader.ts";

const authenticate = (scope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
    return session;
  });

const decodeReloadBody = Schema.decodeUnknownEffect(Schema.Struct({ build: Schema.String }));

// Handlers run in the request fiber's context, which carries the server's services
// but not this layer's own, so the loader is resolved once here and closed over.
const layerList = (loader: PluginLoader.PluginLoader["Service"]) =>
  HttpRouter.add(
    "GET",
    "/api/plugins",
    Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationReadScope);
      return HttpServerResponse.jsonUnsafe(yield* loader.list);
    }),
  );

const layerReload = (loader: PluginLoader.PluginLoader["Service"]) =>
  HttpRouter.add(
    "POST",
    "/api/plugins/:name/reload",
    Effect.gen(function* () {
      yield* authenticate(AuthAccessWriteScope);
      const name = (yield* HttpRouter.params).name ?? "";
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* request.json.pipe(Effect.flatMap(decodeReloadBody), Effect.option);
      if (body._tag === "None") {
        return HttpServerResponse.jsonUnsafe(
          { error: 'The body must be JSON with a "build" string.' },
          { status: 400 },
        );
      }
      return yield* loader.reload(name, body.value.build).pipe(
        Effect.map((plugin) => HttpServerResponse.jsonUnsafe(plugin)),
        Effect.catchTags({
          PluginNotFoundError: (error) =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 404 }),
            ),
          PluginBuildNotFoundError: (error) =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 404 }),
            ),
        }),
        // The previous build keeps running; the requester gets the cause.
        Effect.catch((error) =>
          Effect.map(loader.list, (plugins) =>
            HttpServerResponse.jsonUnsafe(
              {
                error: PluginLoader.describeLoadError(error),
                plugin: plugins.find((plugin) => plugin.name === name),
              },
              { status: 409 },
            ),
          ),
        ),
      );
    }),
  );

// A plugin route reads with the read scope and does anything else with the write
// scope; the handler gets the session's scopes to gate further on its own.
const layerPluginRoutes = (loader: PluginLoader.PluginLoader["Service"]) =>
  HttpRouter.add(
    "*",
    "/api/plugins/:name/*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* authenticate(
        request.method === "GET" || request.method === "HEAD"
          ? AuthOrchestrationReadScope
          : AuthAccessWriteScope,
      );
      const params = yield* HttpRouter.params;
      const handler = loader.route(params.name ?? "");
      if (handler === undefined) {
        return HttpServerResponse.empty({ status: 404 });
      }
      return yield* handler(request, `/${params["*"] ?? ""}`, session.scopes).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("plugin route failed", { plugin: params.name, cause }).pipe(
            Effect.as(HttpServerResponse.empty({ status: 500 })),
          ),
        ),
      );
    }),
  );

/** The routes over a given loader; the server's `layer` provides the real one. */
export const layerRoutes = (loader: PluginLoader.PluginLoader["Service"]) =>
  Layer.mergeAll(layerList(loader), layerReload(loader), layerPluginRoutes(loader));

export const layer = Layer.unwrap(Effect.map(PluginLoader.PluginLoader, layerRoutes)).pipe(
  Layer.provide(PluginLoader.layer),
);
