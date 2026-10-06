import { expect, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PluginLoader from "./PluginLoader.ts";
import * as PluginsHttp from "./http.ts";

const SESSIONS: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  "Bearer reader": [AuthOrchestrationReadScope],
  "Bearer writer": [AuthOrchestrationReadScope, AuthAccessWriteScope],
};

// Sessions by bearer token; anything else is an invalid credential.
const environmentAuth = {
  authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) => {
    const scopes = SESSIONS[request.headers.authorization ?? ""];
    return scopes === undefined
      ? Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({ diagnostic: "unknown" }))
      : Effect.succeed({
          sessionId: AuthSessionId.make("session-1"),
          subject: "test",
          method: "bearer-access-token" as const,
          scopes,
        });
  },
} as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

it.effect("plugin routes read with the read scope and write with the write scope", () =>
  Effect.gen(function* () {
    const seen: Array<{ method: string; path: string; scopes: ReadonlyArray<string> }> = [];
    const loader = PluginLoader.PluginLoader.of({
      list: Effect.succeed([]),
      reload: () => Effect.die("not used by these routes"),
      route: (name) =>
        name === "alpha"
          ? (request, path, scopes) => {
              seen.push({ method: request.method, path, scopes });
              return Effect.succeed(HttpServerResponse.text("ok"));
            }
          : undefined,
    });
    const web = HttpRouter.toWebHandler(
      PluginsHttp.layerRoutes(loader).pipe(
        Layer.provideMerge(Layer.succeed(EnvironmentAuth.EnvironmentAuth, environmentAuth)),
      ),
      { disableLogger: true },
    );
    const send = (method: string, path: string, authorization: string) =>
      Effect.promise(() =>
        web.handler(new Request(`http://127.0.0.1${path}`, { method, headers: { authorization } })),
      );

    yield* Effect.acquireUseRelease(
      Effect.void,
      () =>
        Effect.gen(function* () {
          expect((yield* send("GET", "/api/plugins/alpha/ping", "Bearer reader")).status).toBe(200);
          expect((yield* send("HEAD", "/api/plugins/alpha/ping", "Bearer reader")).status).toBe(
            200,
          );
          expect((yield* send("POST", "/api/plugins/alpha/ping", "Bearer reader")).status).toBe(
            403,
          );
          expect((yield* send("DELETE", "/api/plugins/alpha/ping", "Bearer reader")).status).toBe(
            403,
          );
          expect((yield* send("POST", "/api/plugins/alpha/ping", "Bearer writer")).status).toBe(
            200,
          );
          expect((yield* send("GET", "/api/plugins/alpha/ping", "Bearer nobody")).status).toBe(401);
          expect((yield* send("GET", "/api/plugins/beta/ping", "Bearer reader")).status).toBe(404);
          expect(seen).toEqual([
            { method: "GET", path: "/ping", scopes: [AuthOrchestrationReadScope] },
            { method: "HEAD", path: "/ping", scopes: [AuthOrchestrationReadScope] },
            {
              method: "POST",
              path: "/ping",
              scopes: [AuthOrchestrationReadScope, AuthAccessWriteScope],
            },
          ]);
        }),
      () => Effect.promise(() => web.dispose()),
    );
  }),
);
