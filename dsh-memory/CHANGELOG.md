# Changelog

## 1.0.0 — 2026-11-10

### Added

- Persistent cross-session memory for DeepSeek Harness.
- Hybrid retrieval: 1024-d semantic cosine + BM25 keyword search + weighted RRF.
- Three-tier cache: L1 process LRU, L2 local JSON file, optional L3 Redis.
- Per-user `index_version` cache invalidation anchor; write-after-read safety.
- PII masking before embedding and persistence.
- Content-hash deduplication, Idempotency-Key support, optimistic locking, soft/hard delete.
- Batch write (≤100) with one embedding batch and optional best-effort atomic mode.
- `memory_search`, `memory_write`, and `memory_manage` agent tools.
- Web management page: search, save, edit, delete, cache statistics, health.
- `POST /dsh-memory/api/*` REST surface with request IDs and structured errors.
- TEI and OpenAI-compatible embedding providers, embedding cache, local hashing fallback.
- Embedding source isolation; `reembed force=true` after switching models.
- Real BGE-M3 benchmark (`npm run test:semantic`) and seven offline test suites.
- Usage guide and architecture notes.
