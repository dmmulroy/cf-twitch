import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Schema, Scope } from "effect";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";

import { fetchE2eResponse, fetchE2eText } from "./e2e-http-boundary.ts";

const LocalTcpAddress = Schema.Struct({ port: Schema.Int });

const parseLocalTcpAddress = Schema.decodeUnknownEffect(LocalTcpAddress);

const listenOnLocalhost = (server: Server): Effect.Effect<string> =>
  Effect.callback((resume) => {
    server.once("error", (cause) => resume(Effect.die(cause)));
    server.listen(0, "127.0.0.1", () => {
      resume(
        parseLocalTcpAddress(server.address()).pipe(
          Effect.map(({ port }) => `http://127.0.0.1:${port}`),
          Effect.orDie,
        ),
      );
    });
  });

const closeLocalServer = (server: Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void));
    server.closeAllConnections();
  });

const localHttpServer = (
  respond: (response: ServerResponse) => void,
): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => createServer((_request, response) => respond(response))).pipe(
      Effect.flatMap((server) =>
        listenOnLocalhost(server).pipe(Effect.map((url) => ({ server, url }))),
      ),
      Effect.orDie,
    ),
    ({ server }) => closeLocalServer(server),
  ).pipe(Effect.map(({ url }) => url));

it.live("reports a refused E2E connection as a typed request failure", () =>
  Effect.gen(function* () {
    const unavailableUrl = yield* Effect.scoped(
      Effect.acquireRelease(
        Effect.sync(() => createServer()),
        (server) => closeLocalServer(server),
      ).pipe(Effect.flatMap(listenOnLocalhost)),
    );

    const failure = yield* fetchE2eResponse(unavailableUrl).pipe(Effect.flip);

    expect(failure._tag).toBe("E2eHttpRequestError");
    expect(failure).toMatchObject({ method: "GET", url: unavailableUrl });
  }),
);

it.live("reports a disconnected E2E body as a typed response-body failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* localHttpServer((response) => {
        response.writeHead(200, { "content-length": "100", "content-type": "text/plain" });
        response.flushHeaders();
        response.write("partial");
        setTimeout(() => response.destroy(), 10);
      });

      const failure = yield* fetchE2eText(url).pipe(Effect.flip);

      expect(failure._tag).toBe("E2eHttpResponseBodyError");
      expect(failure).toMatchObject({ method: "GET", url });
    }),
  ),
);

it.live("aborts the E2E request transport when its Effect is interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requestStarted = Promise.withResolvers<void>();
      const requestClosed = Promise.withResolvers<void>();
      let requestWasClosed = false;

      const url = yield* localHttpServer((response) => {
        requestStarted.resolve();
        response.once("close", () => {
          requestWasClosed = true;
          requestClosed.resolve();
        });
      });

      const running = yield* fetchE2eText(url).pipe(Effect.forkScoped);

      yield* Effect.promise(() => requestStarted.promise);
      yield* Fiber.interrupt(running);
      yield* Effect.promise(() => requestClosed.promise);

      expect(requestWasClosed).toBe(true);
    }),
  ),
);
