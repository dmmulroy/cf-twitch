{
  "id": "e6bb77bd",
  "title": "Research Durable Object RPC/data-plane-control-plane patterns for wrapStub improvements",
  "tags": [
    "research",
    "durable-objects",
    "rpc",
    "code-review"
  ],
  "status": "closed",
  "created_at": "2026-04-09T13:26:09.765Z"
}

Reviewed apps/api/src/lib/durable-objects.ts and Cloudflare docs on Durable Object control-plane/data-plane separation, Durable Object stubs, RPC lifecycle, and RpcTarget. Prepared three design options for improving wrapStub: (1) incremental split of control-plane bootstrap from data-plane result wrapping, (2) RpcTarget session/handle approach for metadata + native RPC semantics, and (3) full control-plane registry/bootstrap architecture that removes generic wrapStub from the hot path. Ready to summarize tradeoffs and recommendation for code review feedback.
