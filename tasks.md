# ai-history3 — Tasks Roadmap

This roadmap is self-contained for work inside ai-history3/. Reference: CLAUDE.md, technical_challenges_sqlite.md, technical_challenges_transformer.md, technical_challenges_chrome_api.md, guideline_ui.md, constitution.md.

Phase 1.1 — Scaffold Extension Skeleton
- [x] Create folders under `chrome-extension/`: `sidepanel/`, `bridge/`, `db/` (optional docs), `lib/` (already populated), `icons/` (present)
- [x] Add placeholders: `sidepanel/history_search.html`, `sidepanel/history_chat.html`, `debug.html`, `offscreen.html`
- [x] Add scripts: `background.js`, `offscreen.js`, `sidepanel/history_search.js`, `sidepanel/history_chat.js`, `debug.js`, `bridge/db-bridge.js`, `bridge/ai-bridge.js`
- [x] Ensure all imports reference local `lib/` assets

Phase 1.2 — Manifest.json & CSP
- [x] Create `chrome-extension/manifest.json` (MV3) with: `background.service_worker`, `side_panel.default_path`, `action`, `icons`, `permissions`, `host_permissions`, `web_accessible_resources`
- [x] Add icons mapping: `{ "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" }` and set `action.default_icon`
- [x] Add `web_accessible_resources` for `lib/*.wasm`, `lib/transformers.min.js`, `lib/sqlite3.mjs`
- [x] Set CSP: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://huggingface.co https://*.huggingface.co https://cdn.jsdelivr.net;`

Phase 1.3 — Background + Side Panel Wiring
- [x] Register side panel default path = `sidepanel/history_search.html`
- [x] Add context menu: "AI History: Debug" → opens `debug.html`
- [x] Offscreen orchestration: create/reuse `offscreen.html` on demand; message routing setup

Phase 1.4 — Offscreen Bootstrap & RPC Bridge
- [x] Implement `offscreen.html` (minimal) and `offscreen.js` (single entrypoint)
- [x] Implement message router: typed requests with IDs, promises for responses
- [x] Expose handlers: `initDb`, `ingestPage`, `search`, `embed`, `summarize`, `clearDb`, `clearModelCache`, `exportDb`, `importDb`

Phase 2.1 — SQLite + sqlite-vec Initialization
- [x] Load `lib/sqlite3.mjs`/`lib/sqlite3.wasm`, use IndexedDB VFS, open `/ai-history.db`
- [x] Create schema: `pages`, `pages_fts` (FTS5), `page_embeddings`
- [x] ~~Document/implement fallback to IndexedDB-backed VFS if OPFS unavailable~~ (OPFS removed, IndexedDB only)

Phase 2.2 — FTS5 Maintenance and Upserts
- [x] Implement code-level sync to keep `pages_fts` in sync with `pages` inserts/updates
 - [x] Implement idempotent upsert by URL; update `visit_count`, `last_visit_at` (handles vec0 and fallback paths)

Phase 2.3 — Ingestion Pipeline
- [x] Listen: `chrome.history.onVisited` + `chrome.tabs.onUpdated({status:'complete'})`
- [x] Extract page text via `chrome.scripting.executeScript`; sanitize; avoid sensitive inputs
- [x] Store page row; update FTS; compute/store embedding; optional summary on idle

Phase 3.1 — Transformers.js Setup (Embeddings)
 - [x] Configure ONNX runtime: `env.backends.onnx.wasm.proxy=false`, `numThreads=1`, `simd=false`, `wasmPaths=chrome.runtime.getURL('lib/')`
 - [x] Implement `embed(text)` using lightweight sentence model (~384 dims)
 - [x] Add model cache management; expose `clearModelCache`

Phase 3.2 — Candidate Generation (Hybrid)
- [x] Implement FTS5 BM25 search against `pages_fts` (top K1)
- [x] Implement sqlite-vec cosine search against `page_embeddings` (top K2)
- [x] Implement RRF merge (k=60 default) into ~K candidates

Phase 3.3 — Reranking (Stage 2)
 - [x] Normalize BM25/cosine; compute weighted hybrid score + recency/visits boosts
 - [ ] Optional cross-encoder reranker (Transformers.js) behind `aiPrefs.enableReranker`; fallback gracefully
 - [x] Return top N with full metadata for UI/Chat

Phase 3.4 — Search API Surface
 - [x] Implement `search(query, { mode, limit })` in offscreen: modes = `hybrid-rerank` (default), `hybrid-rrf`, `text`, `vector`
 - [x] Add `bridge/db-bridge.js` to call offscreen methods from UI
 - [x] Add pagination support (offset) in offscreen search and DB queries; dedupe on append

Phase 4.1 — Side Panel Search UI
- [x] Build `history_search.html`/`.js`: input + debounced query, results list, loader, error/empty states
- [x] Render items with favicon (`chrome://favicon`), title, URL, snippet/summary
- [x] "Load more" or infinite scroll; fetch next pages

Phase 4.2 — Advanced Options & Preferences
- [x] Advanced panel (slide down/out) to select mode: Hybrid+Rerank, Hybrid (RRF), Text-only, Vector-only
- [x] Persist `searchMode` to `chrome.storage.local`; restore on load

Phase 4.3 — Page Toggle UX
- [x] Add in-panel toggle to switch between Search and Chat pages
- [x] Persist `lastSidePanelPage`

Phase 5.1 — Chat UI (Side Panel)
- [x] Build `history_chat.html`: chat transcript, input, ellipsis loader, context trimming (last ~10–12 turns)
- [x] Build `history_chat.js`: chat functionality implementation
- [x] Toggle back to Search page seamlessly
 - [x] Include recent chat turns in AI prompt; trim to last 10–12 turns

Phase 5.2 — Prompt API Integration
- [x] Create `bridge/ai-bridge.js` for `window.ai.languageModel`
- [x] Build context from top K search results; enforce link inclusion in system prompt
- [x] Handle failure with structured response fallback (top results with links)
 - [x] Adopt `ai-bridge.js` in Chat UI for session + prompts

Phase 6.1 — Debug Page (DB Explorer)
- [x] Build `debug.html`/`.js` for query runner (read-only default, guarded write toggle)
- [x] Buttons: Clear DB, Clear Model Cache, Export DB, Import DB
  - [ ] Optional: Expose DB size in `get-stats` for display
  - [x] Preferences toggles: `enableRemoteWarm`, `enableReranker`; reload embeddings

Phase 6.2 — Background Context Menu
- [x] Ensure "AI History: Debug" opens `debug.html` in new tab
- [x] Add guardrails (confirm destructive actions)

Phase 7.1 — Preferences & Resilience
- [x] Implement `searchMode`, `lastSidePanelPage` storage in `chrome.storage.local`
 - [x] Add `aiPrefs { enableReranker, allowCloudModel }` storage + wire-up
- [x] Offscreen lifecycle: single-instance reuse; reconnection logic; retries with backoff

Phase 7.2 — Error Handling & Fallbacks
- [x] FTS5 absent → LIKE fallback; log in debug
- [x] sqlite-vec absent → text-only mode; log in debug
 - [x] Embedding model load fail → text-only; retry option
- [x] Prompt session fail → structured response fallback

Phase 8.1 — Manual QA
- [ ] Verify: ingestion on visited pages, search modes, chat links, debug tools
- [ ] Validate performance targets: Search <300ms (no cross-encoder), rerank ~600–800ms @K≈150 where enabled

Phase 8.2 — Performance Tuning
- [ ] Index and query tuning; caching; reduce payloads
- [ ] Gate heavy reranker on capable devices; add toggle in Debug

Phase 8.3 — Code Cleanup & Optimization
- [x] Force IndexedDB VFS (remove OPFS complexity as not suitable for use case)
- [x] Clean up trial-and-error leftover code and redundant fallbacks
- [x] Remove excessive debug logging and simplify overly defensive patterns
- [x] Streamline debug.html UI (remove non-functional extraction testing)
- [x] Simplify mock embedding model implementation
- [x] Remove unused functions and dead code paths

Phase 8.4 — Packaging & Docs
- [ ] Update `manifest.json: version`; zip `chrome-extension/` for release
  - [ ] Update README/notes (local docs); document optional remote endpoints (local‑first policy)
  - [ ] Final privacy pass: no telemetry; explicit local‑first behavior with optional remote warm‑up
