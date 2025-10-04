## Overview
LLM‑Powered Browser History (Chrome MV3 Side Panel)

Scope: This CLAUDE.md applies to everything under ./
Audience: Engineers building the Chrome extension described here and agents editing files in this folder.

## Objectives

- Ship a Chrome MV3 extension that provides “LLM‑powered browser history” using Chrome’s on‑device AI APIs in Chrome Canary.
- Store and search history locally using PGlite with pgvector for vector similarity search and PostgreSQL full-text search.
- Default query mode: Hybrid retrieval with reranking (two‑stage) as described in docs/pglite.md.
- Offer advanced modes: Hybrid (RRF), Text‑only (PostgreSQL full-text search), Vector‑only.
- UI delivered via Chrome Side Panel with two pages the user can switch between:
  1) `history_search.html` (default)
  2) `history_chat.html` (Prompt API‑powered chat)
- Provide a dev/debug page `debug.html` (DB explorer + Clear DB), also reachable from the extension’s context menu.

See also: docs/pglite.md, docs/transformer.md, docs/chrome_api.md, constitution.md.

## Tech Stack
- PGlite (lightweight PostgreSQL in WASM)
- pgvector extension for vector similarity search
- Transformers.js
- Chrome AI APIs, which are available in Chrome Canary

## High‑Level Architecture

- Background (service worker): lifecycle, side panel setup, context menu, offscreen document orchestration.
- Offscreen document: runs heavy/long‑lived tasks (PGlite + pgvector, PostgreSQL full-text search, Transformers.js embeddings, optional reranker) and exposes a request/response bridge.
- UI (side panel): two HTML pages, separate JS controllers sharing a thin client to the offscreen services.
- Storage: PGlite database stored in IndexedDB. Preferences in `chrome.storage.local`.
- Chrome AI: Chrome 138+ global APIs `LanguageModel` (Prompt), `Summarizer` (optional per‑page summary generation) with fallback to legacy `window.ai` APIs.


## Manifest and Permissions (MV3)

- `manifest_version: 3`
- `action`: provides toolbar button; clicking opens side panel default page.
- `icons`: `{ "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" }`
- `action.default_icon`: same mapping as `icons`.
- `side_panel.default_path`: `history_search.html`
- `background.service_worker`: `background.js`
- `permissions`: `history`, `sidePanel`, `storage`, `scripting`, `tabs`, `activeTab`, `contextMenus`, `offscreen`, `webNavigation`
- `optional_host_permissions`: `https://*/*`, `http://*/*` (needed to extract page content + favicons)
- `content_scripts`: Automatic content extraction script that runs on all HTTP/HTTPS pages at `document_idle`
- `web_accessible_resources`: All library files including WASM, data files, and models
  - `"resources": ["lib/*.wasm", "lib/*.data", "lib/*.js", "lib/*.tar.gz", "lib/vector/**", "lib/models/**"]`
  - `"matches": ["<all_urls>"]`
- `content_security_policy.extension_pages` should allow model fetch hosts (if any) used by Transformers.js (e.g., huggingface.co) only as needed. Keep CSP minimal and explicit. Example:
  - `"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://huggingface.co https://*.huggingface.co https://hf.co https://*.hf.co https://cdn.jsdelivr.net;" }`


## Directory Layout (actual)

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
  - debug.html
  - debug.js
  - content-extractor.js (content script for page text extraction)
  - lib/
    - pglite.js (with pgvector extension included)
    - PGlite WASM files and chunks
    - transformers.min.js and ONNX runtime artifacts: ort-wasm.wasm, ort-wasm-simd-threaded.wasm
    - models/ (local embedding model files)
  - bridge/
    - db-bridge.js (request/response client used by UI)
    - ai-bridge.js (Prompt + Summarizer utilities)
    - keyword-extractor.js (Chrome AI keyword extraction service)
    - chrome-ai-loader.js (Chrome AI detection and session management)

Bundled libraries are present under `chrome-extension/lib/` in this repo.

Re‑use and adapt working patterns/code as documented in:
- docs/pglite.md (embedding, vector search with pgvector, PostgreSQL full-text search, hybrid + rerank, RRF)
- docs/transformer.md (Transformers.js configuration and constraints)
- docs/chrome_api.md (Chrome AI Prompt/Summarizer usage)
- constitution.md (conventions and packaging)

## Recent Implementation Updates (January 2025)

### Chrome AI Integration Complete
- **Full Chrome 138+ API Support**: Integrated global `LanguageModel` and `Summarizer` APIs with proper session management, `initialPrompts`, and `append()` context injection
- **No Fallbacks Strategy**: Extension requires Chrome AI availability; fails gracefully with clear error messages if APIs are unavailable
- **Keyword Extraction Service**: New `keyword-extractor.js` uses Chrome AI with JSON Schema `responseConstraint` for structured query analysis
- **Session Quota Tracking**: Implemented `inputUsage` vs `inputQuota` monitoring with automatic session recreation

### Two-Stage Chat Search Flow
- **Stage 1 - Keyword Extraction**: AI analyzes user queries to extract keywords using structured JSON Schema constraints
- **Stage 2 - Enhanced Search**: Uses extracted keywords for filtered vector similarity search with semantic boosting and browser history integration
- **Context Composition**: Builds AI context using `initialPrompts` for priming and `append()` for dynamic search results injection

### PGlite Chat Message Retention
- **New Schema Tables**: Added `chat_thread` and `chat_message` tables with FIFO eviction triggers
- **200-Message Limit**: Automatic pruning keeps newest 200 messages per thread using PostgreSQL triggers
- **Session Continuity**: Recent messages (20 max) provide context for new AI sessions using `getRecentMessagesForSession()`

### Enhanced Debug Interface
- **Chrome AI Testing**: Comprehensive testing tools for Prompt API, Summarizer API, and keyword extraction
- **Real-time Monitoring**: Live status indicators for Chrome AI availability and model download progress
- **Performance Metrics**: Step-by-step timing analysis for keyword extraction and search pipeline
- **Queue Management**: Advanced tools for testing and monitoring the AI summarization queue system


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

Full-text search (using PostgreSQL):
- Use PostgreSQL's built-in full-text search capabilities with tsvector/tsquery
- Create GIN indexes on tsvector columns for efficient text search

Vector column (pgvector):
- Add `embedding` column to `pages` table:
  - `embedding` vector(384)  // 384-dimensional vector
  - Create index using: `CREATE INDEX ON pages USING ivfflat (embedding vector_cosine_ops)`

Notes
- If pages are large, we may chunk content into subdocuments (e.g., `page_chunks` + `page_chunks_fts` + `chunk_embeddings`). Start with whole‑page embedding; add chunking later if recall is insufficient.
- Use PostgreSQL triggers to automatically update tsvector columns when pages are inserted/updated.
- Maintain vector embeddings through application code when content changes.


## Ingestion Pipeline

- Listen to `chrome.history.onVisited` + `chrome.tabs.onUpdated({ status: 'complete' })` to detect likely ingestion points.
- Use `chrome.scripting.executeScript` to extract main text from the active tab (Readability‑style or DOM heuristics). Avoid capturing sensitive inputs; never read inside password fields; honor extension permissions.
- Persist/merge into `pages` (upsert by URL). Update `visit_count`, `last_visit_at`.
- Generate embedding with Transformers.js (see below) and store in the `embedding` column.
- Update tsvector column for full-text search indexing.
- Queue substantial content (>100 chars) for AI summarization via database-backed queue system.

### AI Summarization Queue (Database-Backed)
- **Architecture**: Uses PostgreSQL table `summarization_queue` with LISTEN/NOTIFY for instant processing
- **No Polling**: Replaced 30-second intervals with real-time database notifications
- **Persistent**: Queue survives extension restarts and can be queried via SQL in debug panel
- **Status Tracking**: Items progress through states: `pending` → `processing` → `completed`/`failed`
- **Retry Logic**: Failed items are retried up to 3 times before being marked as failed
- **Rate Limiting**: 2-second delay between processing items to avoid overwhelming AI API

Queue Schema:
```sql
CREATE TABLE summarization_queue (
  id SERIAL PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  domain TEXT,
  content_text TEXT,
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP
);
```

Performance/UX
- Run heavy work in offscreen document. Database-backed queue with instant notifications via LISTEN/NOTIFY.
- Debounce repeated visits in short windows to avoid churn.
- Queue processing starts immediately when new items are added (no polling delay).


## Embeddings and Models (Transformers.js)

- Default embedding model: lightweight sentence embedding model with output dimension ~384 (e.g., MiniLM‑L6‑v2 class). Use the choice and configuration documented in docs/transformer.md.
- Load in offscreen document with Workers disabled per CSP constraints (see docs/transformer.md); ensure ONNX runtime is available.
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
- Run PostgreSQL full-text search using tsquery and vector similarity search using pgvector's cosine distance operators.
- Take top K1 (PostgreSQL FTS) and top K2 (vector). Merge via RRF or weighted union to produce ~K candidates (e.g., 150–200).
  - RRF score per list with `k = 60` (tunable), `rrf = 1/(k + rank)`.

Stage 2 — Reranking:
- For merged candidates, compute a hybrid score and apply a lightweight reranker:
  - Base score = `w_vec * cosine + w_text * text_rank_norm`
  - Add recency and popularity features: `+ w_recency * recencyBoost + w_visits * visitBoost`
  - Optionally apply a cross‑encoder reranker from Transformers.js when device allows (guarded by a setting; see docs/transformer.md). Fallback to base score if reranker unavailable.
- Return top N (e.g., 20–50) with full metadata.

Advanced Modes (user‑selectable in UI’s Advanced panel):
- Hybrid (RRF) only (no stage‑2 reranker)
- Text only (PostgreSQL full-text search with ts_rank)
- Vector only (cosine similarity via pgvector)

Normalization & Scoring
- Normalize ts_rank scores and cosine similarities to [0, 1] (e.g., z‑score or min‑max per candidate set) before weighted sum.
- Suggested defaults: `w_vec=0.5, w_text=0.3, w_recency=0.1, w_visits=0.1` (tune as needed).


## Browser History Integration

The extension combines Chrome's browser history API with PGlite database for comprehensive search results:

**Search Behavior:**
- **Empty query**: Shows all browser history from the past 90 days, merged with PGlite data
- **Search query**: Combines results from both PGlite search and Chrome history search
- **Deduplication**: URLs present in both sources show PGlite data (with AI summaries) preferentially
- **90-day retention**: Only considers browser history from the last 90 days (automatic filtering)

**Result Display:**
- **AI Summary badge** (🤖): Indicates entries with AI-generated summaries from PGlite
- **Source badge**: Shows "Indexed" for PGlite entries, "Browser" for history-only entries
- **Fallback summaries**: Browser-only entries show "No AI summary available yet. Visit this page to generate one."
- **Progressive enhancement**: As users revisit pages, summaries are generated and stored

## Side Panel UI

Two pages; user can toggle between them. Remember the last‑used page and search mode in `chrome.storage.local`.

1) history_search.html (default)
- Layout:
  - Input with debounced search (empty query shows all 90-day history)
  - Results list with favicon (`chrome://favicon`) + title + URL + short summary/snippet
  - Visual badges for AI summaries and source type (PGlite vs browser history)
  - Infinite scroll or "Load more"
  - Loader while querying (skeleton rows or spinner)
- Advanced panel (slide down/out) allows switching mode: Hybrid+Rerank (default), Hybrid (RRF), Text only, Vector only. Persist selection.
- Provide clear empty state and robust error handling.

2) history_chat.html
- Chat interface, simple transcript; trim context pragmatically when it grows too large (e.g., keep last ~10–12 turns, or token budget ~4–8k where possible).
- On submit:
  - Retrieve candidates using the same Hybrid+Rerank pipeline.
  - Prompt Chrome AI (global `LanguageModel` API) with system instructions that force link inclusion.
  - Render answer with clickable links to top relevant pages and short rationales. Use an ellipsis loader while generating.
- If LLM unavailable, fall back to a structured response builder that lists the top results with links and snippets.


## Prompt API Usage (Chat)

- Create session with Chrome 138+ `LanguageModel.create()` or legacy `window.ai.languageModel.create()`. Prefer on‑device model in Canary if available; otherwise respect user settings before any network use.
- System prompt should:
  - Instruct model to answer based on provided history snippets only.
  - Require inclusion of links for top results.
  - Keep responses concise; use bullet points with titles and URLs.
- Chat turn logic:
  - Build a context block from top K retrieved items: `[title] — [url] — [summary or snippet]`.
  - Provide the user’s query and the context block to `session.prompt`.
  - Render streaming if available; otherwise show loader until completion.


## Debug Page (debug.html)

**IMPORTANT**: The debug page MUST use actual production code for testing. Do NOT create separate versions of functions in debug.js. The goal is to test the exact same code path that users experience.

- **Site Permissions Management**:
  - Check current site access for content extraction
  - Grant site permissions with one-click buttons
  - Links to Chrome extension settings for global permissions
  - Troubleshooting guide for "Receiving end does not exist" errors

- **Chrome AI Integration Testing**:
  - Real-time Chrome AI availability detection (Chrome 138+ global APIs with legacy fallback)
  - Interactive keyword extraction testing with JSON Schema validation
  - Summarizer API testing with content input and progress monitoring
  - **Full chat search flow testing using production functions from `history_chat.js`**
  - Step-by-step timing analysis of actual production code path
  - Model download progress indicators and quota usage tracking

- **DB Explorer**:
  - Run arbitrary SQL (read‑only by default, with a guarded "Write mode" toggle)
  - Inspect table counts, index health, and recent ingestion queue
  - PostgreSQL-specific sample queries for vector operations and full-text search
  - Buttons: Clear DB (drop and recreate tables), Clear Model Cache, Export DB, Import DB (optional)

- **AI Summarization Queue Management**:
  - Real-time queue stats (queued, processing, completed, failed)
  - Currently processing item details with URL and progress
  - Queue management buttons (Process Queue, Clear Queue, Reset Stuck Items)
  - Advanced debugging tools: Add test items, monitor LISTEN/NOTIFY, show processing timeline
  - Sample SQL queries for queue inspection and maintenance

- **Content Analysis Tools**:
  - Recent pages content analysis with embedding status
  - Search mode performance comparison (hybrid, vector-only, text-only)
  - Content extraction statistics and favicon loading status

- **System Monitoring**:
  - Live log viewer with filtering by level (info, warn, error, debug)
  - Auto-refresh capabilities and log export functionality
  - Performance metrics for search operations and AI model operations

- **Context Menu Integration**: "AI History: Debug" entry opens `debug.html` in new tab for quick access

### Debug Testing Requirements:
- All testing functions MUST import and use production code from `sidepanel/` and `bridge/` directories
- Functions should be accessed via `window.chatPageController` exports or direct imports
- Never create duplicate implementations in `debug.js` - always use the actual production functions
- This ensures debug results accurately reflect user experience


## Background and Offscreen Orchestration

- `background.js` responsibilities:
  - Register side panel default path.
  - Create context menu and handle clicks to open `debug.html`.
  - Ensure one offscreen document is created (`offscreen.html`) at startup/first use; reuse single instance.
  - Provide a message router between UI and offscreen for DB/AI requests (request/response with IDs).

- `offscreen.html`/`offscreen.js` responsibilities:
  - Initialize PGlite with pgvector extension and ensure schema.
  - Configure pgvector for vector similarity search as documented in docs/pglite.md.
  - Initialize Transformers.js (workers disabled per CSP constraints per prior prototype notes).
  - Expose handlers: `ingestPage`, `search(query, mode, limit)`, `embed(text)`, `summarize(text)`, `clearDb()`, etc.


## State, Caching, and Persistence

- `chrome.storage.local` keys:
  - `searchMode` = 'hybrid-rerank' | 'hybrid-rrf' | 'text' | 'vector'
  - `lastSidePanelPage` = 'search' | 'chat'
  - `aiPrefs` = { enableReranker: boolean, allowCloudModel: boolean }
- DB storage: PGlite database in IndexedDB (key: `ai-history-pglite`).
- Model caches: Transformers.js default; provide clear action in debug.


## UX Requirements

- Always show favicon, title, readable URL, and short snippet/summary in results.
- Show a visible loader during search and during chat generation.
- Ensure results contain clickable links; in chat these MUST be present when any matches exist.
- Remember the last used search mode and restore on load.


## Error Handling and Fallbacks

- If PostgreSQL full-text search fails, fallback to simple ILIKE or client-side keyword filtering.
- If pgvector unavailable, run text‑only and surface a warning in debug.
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

- docs/pglite.md: PGlite + pgvector setup, IndexedDB configuration, API surface, RRF, and hybrid + rerank details
- docs/transformer.md: Transformers.js configuration (workers disabled) and embedding/reranking pipeline
- docs/chrome_api.md: Chrome AI Prompt API wiring and chat interaction patterns

Ignore
- Any sidecar processes and mock embedding implementations. Always use pgvector and Transformers.js here.


## Example Pseudocode (Search)

```js
async function hybridSearch(query, { mode = 'hybrid-rerank', limit = 25 } = {}) {
  // Handle empty queries: show combined history
  if (!query || query.trim().length === 0) {
    return await getCombinedHistory({ limit });
  }

  // Get results from both PGlite and Chrome history
  const [pgliteResults, browserResults] = await Promise.allSettled([
    // PGlite search with embeddings
    (async () => {
      const queryVec = await embed(query);
      return await db.search(query, { mode, limit: Math.ceil(limit * 1.5), queryVec });
    })(),
    // Chrome browser history search (90-day filtered)
    chrome.history.search({
      text: query,
      startTime: Date.now() - (90 * 24 * 60 * 60 * 1000)
    })
  ]);

  // Merge and deduplicate results (PGlite takes priority)
  const merged = mergeHistoryResults(
    pgliteResults.value || [],
    browserResults.value || []
  );

  return merged.slice(0, limit);
}

async function getCombinedHistory({ limit = 25 }) {
  // Get all browser history from last 90 days
  const browserHistory = await chrome.history.search({
    text: '',
    startTime: Date.now() - (90 * 24 * 60 * 60 * 1000),
    maxResults: 1000
  });

  // Get PGlite entries (no search, just recent)
  const pgliteResults = await db.search('', { mode: 'text', limit: 1000 });

  // Merge, deduplicate, and sort by last visit time
  return mergeHistoryResults(pgliteResults, browserHistory).slice(0, limit);
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
    const session = await createLanguageSession(); // Uses Chrome 138+ API with fallback
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


## Implemented Features (January 2025)

- **Chat Message Retention**: PGlite-based chat_thread and chat_message tables with automatic FIFO eviction (200 message limit)
- **Keyword Extraction Service**: Chrome AI-powered keyword extraction with JSON Schema responseConstraint for structured output
- **AI Summarization Queue**: Database-backed queue system with LISTEN/NOTIFY for real-time processing, replacing polling architecture
- **Browser History Integration**: 90-day retention with merged PGlite/Chrome history results and deduplication
- **Enhanced Debug Interface**: Comprehensive testing tools for Chrome AI integration, queue management, and database operations
- **Content Extraction**: Automatic content extraction via content scripts on page navigation
- **Two-Stage Chat Search**: Keyword extraction → enhanced search with semantic boosting → context-aware AI responses


## Future Work (Non‑blocking)

- **Automatic 90-day retention policy**: Implement background cleanup job using Chrome alarms API to automatically prune PGlite database entries older than 90 days
- Chunk‑level embeddings for long pages.
- On‑device cross‑encoder reranker improvements or knowledge distillation for speed.
- Per‑domain ranking features; personalization toggles.
- Rich snippets (key passages) with Chrome AI Summarizer.


## Guardrails for Contributors

- Do not introduce external analytics/telemetry.
- Keep default mode Hybrid+Rerank. Other modes are advanced.
- Keep UI minimal and fast; side panel only. No separate full‑tab UI unless explicitly requested.
- Re‑use the approaches documented in the docs/* files; avoid reinventing.
- When in doubt, prefer local‑first, offline‑first behavior.
- Update @chrome-extension/debug.html to show SQL queries or things that the chrome extension actually uses
- Ignore folders that are named prototype_*/ unless explicitly referenced.
- This extension uses PGlite with pgvector for all database operations. All code should reflect this architecture.
- Do not read the WASM pglite library when debugging because it's too large. Browse online documentation instead. Show that you require more information so that I can assist.
