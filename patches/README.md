# Dependency patches

## Alchemy 2.0.0-beta.76 Worker platform layer

`alchemy@2.0.0-beta.76` unconditionally includes `@effect/platform-node/NodeServices` in its Cloudflare `WorkerBridge`. Building that aggregate Layer inside workerd eagerly acquires `NodeTerminal`; its first operation calls `process.stdin.once(...)`, but workerd's Node compatibility `process.stdin` is not a Node `EventEmitter`. Every first Worker request therefore fails before the user `fetch` Effect with `TypeError: t.once is not a function`.

`alchemy@2.0.0-beta.76.patch` removes the Node-only aggregate Layer from the workerd bridge. Cloudflare-compatible services remain explicitly composed by Worker application Layers. The regression is exercised by the real local workerd OAuth and Song Queue Worker-to-Durable-Object HTTP scenarios.

When upgrading Alchemy, inspect its Worker bridge for Node terminal acquisition and run the [local workerd suite](../docs/verification.md#local-workerd-harness) without this patch.

**Removal complete when:** the upstream bridge no longer acquires Node terminal services, native Worker-to-DO journeys pass without the patch, and the patch registration/file are removed together.
