## Overview
LLM‑Powered Browser History (Chrome MV3 Side Panel)

Scope: This AGENTS.md applies to everything under ai-history3/.
Audience: Engineers building the Chrome extension described here and agents editing files in this folder.

## Objectives

- Ship a Chrome MV3 extension that provides “LLM‑powered browser history” using Chrome’s on‑device AI APIs in Chrome Canary.
- Store and search history locally using SQLite WASM with sqlite-vec + FTS5.
- Default query mode: Hybrid retrieval with reranking (two‑stage) as described in technical_challenges_sqlite.md.
- Offer advanced modes: Hybrid (RRF), Text‑only (BM25/FTS5), Vector‑only.
- UI delivered via Chrome Side Panel with two pages the user can switch between:
  1) `history_search.html` (default)
  2) `history_chat.html` (Prompt API‑powered chat)
- Provide a dev/debug page `debug.html` (DB explorer + Clear DB), also reachable from the extension’s context menu.

See also: technical_challenges_sqlite.md, technical_challenges_transformer.md, technical_challenges_chrome_api.md, constitution.md.

## Tech Stack
- sqlite-vec-wasm-demo, which can be found as an NPM package
- Transformers.js
- Chrome AI APIs, which are available in Chrome Canary

## High‑Level Architecture

- Background (service worker): lifecycle, side panel setup, context menu, offscreen document orchestration.
- Offscreen document: runs heavy/long‑lived tasks (SQLite + sqlite-vec, FTS5, Transformers.js embeddings, optional reranker) and exposes a request/response bridge.
- UI (side panel): two HTML pages, separate JS controllers sharing a thin client to the offscreen services.
- Storage: SQLite DB in OPFS (preferred) or IndexedDB‑backed VFS as fallback. Preferences in `chrome.storage.local`.
- Chrome AI: `window.ai.languageModel` (Prompt), `window.ai.summarizer` (optional per‑page summary generation).


## Manifest and Permissions (MV3)

- `manifest_version: 3`
- `action`: provides toolbar button; clicking opens side panel default page.
- `icons`: `{ "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" }`
- `action.default_icon`: same mapping as `icons`.
- `side_panel.default_path`: `history_search.html`
- `background.service_worker`: `background.js`
- `permissions`: `history`, `sidePanel`, `storage`, `scripting`, `tabs`, `activeTab`, `contextMenus`, `offscreen`
- `host_permissions`: `https://*/*`, `http://*/*` (needed to extract page content + favicons)
- `web_accessible_resources`:
  - SQLite WASM files: `lib/sqlite3.wasm`, `lib/sqlite3.mjs`
  - ONNX/Transformers.js assets: `lib/transformers.min.js`, `lib/ort-wasm.wasm`, `lib/ort-wasm-simd-threaded.wasm`
  - Suggested manifest snippet:
    - `"web_accessible_resources": [{ "resources": ["lib/*.wasm", "lib/transformers.min.js", "lib/sqlite3.mjs"], "matches": ["<all_urls>"] }]`
- `content_security_policy.extension_pages` should allow model fetch hosts (if any) used by Transformers.js (e.g., huggingface.co) only as needed. Keep CSP minimal and explicit. Example:
  - `"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://huggingface.co https://*.huggingface.co https://hf.co https://*.hf.co https://cdn.jsdelivr.net;" }`


## Directory Layout (target)

- chrome-extension/
  - manifest.json
  - background.js
  - offscreen.html
  - offscreen.js
  - icons/
    - 16.png, 48.png, 128.png
  - sidepanel/
    - history_search.html
    - history_search.js
    - history_chat.html
    - history_chat.js
    - styles.css
    - assets/ (icons, loader svg/gifs)
  - debug.html
  - debug.js
  - lib/
    - sqlite3.mjs, sqlite3.wasm (sqlite-vec included)
    - sqlite3-opfs-async-proxy.js (if used)
    - transformers.min.js and ONNX runtime artifacts: ort-wasm.wasm, ort-wasm-simd-threaded.wasm

Bundled libraries are present under `chrome-extension/lib/` in this repo.
  - db/
    - schema.sql (documentation/reference; schema created in code)
    - migrations/ (if needed later)
  - bridge/
    - db-bridge.js (request/response client used by UI)
    - ai-bridge.js (Prompt + Summarizer utilities)

Re‑use and adapt working patterns/code as documented in:
- technical_challenges_sqlite.md (embedding, vector search, FTS5, hybrid + rerank, RRF)
- technical_challenges_transformer.md (Transformers.js configuration and constraints)
- technical_challenges_chrome_api.md (Chrome AI Prompt/Summarizer usage)
- constitution.md (conventions and packaging)


## Data Model and Schema

Primary tables (one row per logical history document):
- `pages`:
  - `id` INTEGER PRIMARY KEY
  - `url` TEXT UNIQUE
  - `domain` TEXT
  - `title` TEXT
  - `content_text` TEXT (cleaned main content; optionally chunked, see below)
  - `summary` TEXT NULL (optional, via Summarizer; computed lazily)
  - `favicon_url` TEXT NULL
  - `first_visit_at` INTEGER (ms)
  - `last_visit_at` INTEGER (ms)
  - `visit_count` INTEGER

FTS5 virtual table (keyword search):
- `pages_fts` (contentless or with content): columns mirror `title`, `content_text` (and optionally `url` for debugging). If contentless, use external content rowid = `pages.id`.

Vector table (sqlite-vec):
- `page_embeddings`:
  - `id` INTEGER PRIMARY KEY REFERENCES pages(id)
  - `embedding` VECTOR(D)  // D = embedding dimension (default 384)
  - `updated_at` INTEGER (ms)

Notes
- If pages are large, we may chunk content into subdocuments (e.g., `page_chunks` + `page_chunks_fts` + `chunk_embeddings`). Start with whole‑page embedding; add chunking later if recall is insufficient.
- Maintain simple triggers or code‑level sync to keep `pages_fts` aligned with `pages` inserts/updates. If triggers on virtual tables are blocked, do code‑level maintenance (see technical_challenges_sqlite.md).


## Ingestion Pipeline

- Listen to `chrome.history.onVisited` + `chrome.tabs.onUpdated({ status: 'complete' })` to detect likely ingestion points.
- Use `chrome.scripting.executeScript` to extract main text from the active tab (Readability‑style or DOM heuristics). Avoid capturing sensitive inputs; never read inside password fields; honor extension permissions.
- Persist/merge into `pages` (upsert by URL). Update `visit_count`, `last_visit_at`.
- Generate embedding with Transformers.js (see below) and store in `page_embeddings`.
- Index keyword text in `pages_fts`.
- Optionally compute a short `summary` via `window.ai.summarizer` when idle or on demand.

Performance/UX
- Run heavy work in offscreen document. Queue ingestion tasks. Backoff if CPU busy or battery saver.
- Debounce repeated visits in short windows to avoid churn.


## Embeddings and Models (Transformers.js)

- Default embedding model: lightweight sentence embedding model with output dimension ~384 (e.g., MiniLM‑L6‑v2 class). Use the choice and configuration documented in technical_challenges_transformer.md.
- Load in offscreen document with Workers disabled per CSP constraints (see technical_challenges_transformer.md); ensure ONNX runtime is available.
- API surface:
  - `embed(text: string | string[]): Float32Array | Float32Array[]`
- Caching: allow Transformers.js to cache model artifacts (browser storage). Provide a toggle to clear model cache in debug.
- Path config: set `env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('lib/')` so ONNX WASM loads from `chrome-extension://.../lib/`.
 - Runtime flags (match extension constraints):
   - `env.backends.onnx.wasm.proxy = false`
   - `env.backends.onnx.wasm.numThreads = 1`
   - `env.backends.onnx.wasm.simd = false`


## Retrieval: Default Hybrid + Reranking (Two‑Stage)

Stage 1 — Candidate Generation (Hybrid):
- Run BM25/FTS5 query against `pages_fts` and a vector search against `page_embeddings` using cosine similarity.
- Take top K1 (FTS5) and top K2 (vector). Merge via RRF or weighted union to produce ~K candidates (e.g., 150–200).
  - RRF score per list with `k = 60` (tunable), `rrf = 1/(k + rank)`.

Stage 2 — Reranking:
- For merged candidates, compute a hybrid score and apply a lightweight reranker:
  - Base score = `w_vec * cosine + w_bm25 * bm25_norm`
  - Add recency and popularity features: `+ w_recency * recencyBoost + w_visits * visitBoost`
  - Optionally apply a cross‑encoder reranker from Transformers.js when device allows (guarded by a setting; see technical_challenges_transformer.md). Fallback to base score if reranker unavailable.
- Return top N (e.g., 20–50) with full metadata.

Advanced Modes (user‑selectable in UI’s Advanced panel):
- Hybrid (RRF) only (no stage‑2 reranker)
- Text only (BM25 via FTS5)
- Vector only (cosine via sqlite-vec)

Normalization & Scoring
- Normalize BM25 and cosine to [0, 1] (e.g., z‑score or min‑max per candidate set) before weighted sum.
- Suggested defaults: `w_vec=0.5, w_bm25=0.3, w_recency=0.1, w_visits=0.1` (tune as needed).


## Side Panel UI

Two pages; user can toggle between them. Remember the last‑used page and search mode in `chrome.storage.local`.

1) history_search.html (default)
- Layout:
  - Input with debounced search
  - Results list with favicon (`chrome://favicon`) + title + URL + short summary/snippet
  - Infinite scroll or “Load more”
  - Loader while querying (skeleton rows or spinner)
- Advanced panel (slide down/out) allows switching mode: Hybrid+Rerank (default), Hybrid (RRF), Text only, Vector only. Persist selection.
- Provide clear empty state and robust error handling.

2) history_chat.html
- Chat interface, simple transcript; trim context pragmatically when it grows too large (e.g., keep last ~10–12 turns, or token budget ~4–8k where possible).
- On submit:
  - Retrieve candidates using the same Hybrid+Rerank pipeline.
  - Prompt `window.ai.languageModel` with system instructions that force link inclusion.
  - Render answer with clickable links to top relevant pages and short rationales. Use an ellipsis loader while generating.
- If LLM unavailable, fall back to a structured response builder that lists the top results with links and snippets.


## Prompt API Usage (Chat)

- Create session with `window.ai.languageModel.create()`. Prefer on‑device model in Canary if available; otherwise respect user settings before any network use.
- System prompt should:
  - Instruct model to answer based on provided history snippets only.
  - Require inclusion of links for top results.
  - Keep responses concise; use bullet points with titles and URLs.
- Chat turn logic:
  - Build a context block from top K retrieved items: `[title] — [url] — [summary or snippet]`.
  - Provide the user’s query and the context block to `session.prompt`.
  - Render streaming if available; otherwise show loader until completion.


## Debug Page (debug.html)

- DB Explorer:
  - Run arbitrary SQL (read‑only by default, with a guarded “Write mode” toggle).
  - Inspect table counts, index health, and recent ingestion queue.
  - Buttons: Clear DB (drop and recreate tables), Clear Model Cache, Export DB, Import DB (optional).
- Add a context menu entry (via `chrome.contextMenus`) named “AI History: Debug” that opens `debug.html` in a new tab.


## Background and Offscreen Orchestration

- `background.js` responsibilities:
  - Register side panel default path.
  - Create context menu and handle clicks to open `debug.html`.
  - Ensure one offscreen document is created (`offscreen.html`) at startup/first use; reuse single instance.
  - Provide a message router between UI and offscreen for DB/AI requests (request/response with IDs).

- `offscreen.html`/`offscreen.js` responsibilities:
  - Initialize SQLite (with OPFS VFS) and ensure schema.
  - Load sqlite-vec within the WASM build (preferred: statically compiled as documented in technical_challenges_sqlite.md).
  - Initialize Transformers.js (workers disabled per CSP constraints per prior prototype notes).
  - Expose handlers: `ingestPage`, `search(query, mode, limit)`, `embed(text)`, `summarize(text)`, `clearDb()`, etc.


## State, Caching, and Persistence

- `chrome.storage.local` keys:
  - `searchMode` = 'hybrid-rerank' | 'hybrid-rrf' | 'text' | 'vector'
  - `lastSidePanelPage` = 'search' | 'chat'
  - `aiPrefs` = { enableReranker: boolean, allowCloudModel: boolean }
- DB file: `opfs:/ai-history.db` (name flexible; document the actual path in debug).
- Model caches: Transformers.js default; provide clear action in debug.


## UX Requirements

- Always show favicon, title, readable URL, and short snippet/summary in results.
- Show a visible loader during search and during chat generation.
- Ensure results contain clickable links; in chat these MUST be present when any matches exist.
- Remember the last used search mode and restore on load.


## Error Handling and Fallbacks

- If FTS5 unavailable, fallback to simple LIKE or client‑side keyword filtering.
- If sqlite-vec unavailable, run text‑only and surface a warning in debug.
- If Transformers.js fails to load embeddings model, keep text‑only modes and allow retry from debug.
- If reranker model heavy, gate behind `aiPrefs.enableReranker`. Default to base hybrid rerank without cross‑encoder.
- If Prompt API session creation fails, use structured response fallback (top results list with links).


## Coding Conventions

- Language: Type‑safe JS where easy (JSDoc typedefs); ESM modules only; no bundler required to run, but small build step acceptable if needed for assets.
- Keep files small and cohesive; prefer pure functions in offscreen services.
- Use async/await; never block main/UI thread. Heavy work lives in offscreen.
- Prefer named exports; avoid default exports except page scripts.
- Avoid global mutable state; centralize settings access.
- Logging: prefix logs with `[BG]`, `[OFFSCREEN]`, `[SEARCH]`, `[CHAT]`, `[DB]` for clarity; keep verbose logs behind a debug flag.


## Reuse From Local Docs

- technical_challenges_sqlite.md: SQLite + sqlite-vec setup, OPFS configuration, API surface, RRF, and hybrid + rerank details
- technical_challenges_transformer.md: Transformers.js configuration (workers disabled) and embedding/reranking pipeline
- technical_challenges_chrome_api.md: Chrome AI Prompt API wiring and chat interaction patterns

Ignore
- Any sidecar processes and mock embedding implementations. Always use sqlite-vec and Transformers.js here.


## Example Pseudocode (Search)

```js
async function hybridSearch(query, { mode = 'hybrid-rerank', limit = 25 } = {}) {
  const bm25Top = await db.ftsSearch(query, { k: 100 });
  const queryVec = await embed(query);
  const vecTop = await db.vecSearch(queryVec, { k: 100 });

  let candidates;
  if (mode === 'hybrid-rrf') {
    candidates = rrfMerge(bm25Top, vecTop, { k: 60 });
  } else if (mode === 'text') {
    candidates = bm25Top;
  } else if (mode === 'vector') {
    candidates = vecTop;
  } else { // 'hybrid-rerank'
    const merged = rrfMerge(bm25Top, vecTop, { k: 60 });
    candidates = await rerank(query, merged); // weighted hybrid + optional cross-encoder
  }
  return candidates.slice(0, limit);
}
```


## Example Pseudocode (Chat)

```js
async function answerQuery(query) {
  const results = await hybridSearch(query, { mode: 'hybrid-rerank', limit: 20 });
  if (!results.length) return 'No matches found in your history.';

  const ctx = results.slice(0, 8).map(r => `- ${r.title}\n  ${r.url}\n  ${r.summary ?? r.snippet}`).join('\n');
  const sys = `You answer using only the provided items. Always include links.`;
  const prompt = `${sys}\n\nUser question: ${query}\n\nItems:\n${ctx}`;

  try {
    const session = await window.ai.languageModel.create();
    const text = await session.prompt(prompt);
    return text;
  } catch (e) {
    // Fallback structured response
    return results.slice(0, 5).map(r => `• ${r.title} — ${r.url}`).join('\n');
  }
}
```


## Testing and Manual QA

- Install unpacked in Chrome Canary with required flags for on‑device AI enabled.
- Validate: ingestion on visit, search responsiveness, chat link inclusion, debug page actions (Clear DB, Clear cache, Export/Import), and context menu entry opening `debug.html`.
- Performance target: search < 300ms for top‑25 on a mid‑tier laptop without cross‑encoder; rerank K=150 within ~600–800ms where enabled.


## Privacy and Security

- Local‑first: No browsing history leaves the device. Optional network calls are allowed only when the user enables remote warm‑up to download static model files.
- Never transmit browsing history or prompts. Keep CSP strict; allow only the minimal hosts needed for model fetch:
  - huggingface.co, *.huggingface.co, hf.co, *.hf.co, cdn.jsdelivr.net
- Provide a clear “Delete all data” button in debug that drops DB and clears model caches.

### Model policy
- Default embeddings use a bundled local model (`lib/models/...`).
- If `aiPrefs.enableRemoteWarm` is true, offscreen may fetch the larger model over HTTPS and cache it, then hot‑swap. Extension URLs are not cached (Cache API does not support chrome‑extension://).


## Future Work (Non‑blocking)

- Chunk‑level embeddings for long pages.
- On‑device cross‑encoder reranker improvements or knowledge distillation for speed.
- Per‑domain ranking features; personalization toggles.
- Rich snippets (key passages) with window.ai.summarizer.


## Guardrails for Contributors

- Do not introduce external analytics/telemetry.
- Keep default mode Hybrid+Rerank. Other modes are advanced.
- Keep UI minimal and fast; side panel only. No separate full‑tab UI unless explicitly requested.
- Re‑use the approaches documented in the local technical_challenges_* docs; avoid reinventing.
- When in doubt, prefer local‑first, offline‑first behavior.
- update @chrome-extension/debug.html to show sql queries or things that the chrome extension actually uses
- Ignore folders that are named prototype_*/ unless explicitly referenced.
