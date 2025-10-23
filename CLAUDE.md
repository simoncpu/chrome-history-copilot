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

**Database**: PGlite (PostgreSQL in WASM) with pgvector extension for vector similarity search.

**Core Tables**:
- `pages` - Main content table with integrated embeddings and full-text search
- `chat_thread` and `chat_message` - Chat conversation persistence (200-message FIFO limit)
- `summarization_queue` - Database-backed AI summarization queue with LISTEN/NOTIFY

**Key Features**:
- **Vector search**: 384-dim embeddings with pgvector cosine similarity (`<=>` operator)
- **Full-text search**: PostgreSQL tsvector/tsquery with automatic GIN indexes
- **Hybrid retrieval**: RRF (Reciprocal Rank Fusion) + reranking for optimal results
- **Browser history integration**: Merges PGlite indexed content with Chrome's 90-day history

> **Implementation Details**: See [docs/pglite.md](docs/pglite.md) for complete schema, indexes, and query patterns.


## Ingestion Pipeline

**Content Extraction**:
- Automatic content script runs on all HTTP/HTTPS pages at `document_idle`
- Extracts main text using Readability-style DOM heuristics
- Respects privacy: never captures password fields or sensitive inputs

**Processing Flow**:
1. Listen for `chrome.history.onVisited` and `chrome.tabs.onUpdated`
2. Extract page content via content scripts
3. Generate 384-dim embedding with Transformers.js
4. Upsert to `pages` table (updates `visit_count`, `last_visit_at`)
5. Queue for AI summarization (content >100 chars)

**AI Summarization Queue**:
- Database-backed with PostgreSQL LISTEN/NOTIFY for instant processing
- Persistent across extension restarts
- Status tracking: `pending` → `processing` → `completed`/`failed`
- Retry logic: up to 3 attempts with 2-second rate limiting

> **Implementation Details**: See [docs/pglite.md](docs/pglite.md) for queue schema and [offscreen.js](chrome-extension/offscreen.js) for processing logic.


## Embeddings and Models (Transformers.js)

**Model Configuration**:
- **Local model** (default): `Xenova/bge-small-en-v1.5-quantized` (bundled, 384-dim output)
- **Remote model** (optional): `Xenova/bge-small-en-v1.5` (full precision, user opt-in)
- Load in offscreen document with workers disabled for MV3 compatibility

**Runtime Configuration**:
- Single-threaded, no SIMD (required for Chrome extension CSP)
- Local-first: bundled model in `lib/models/`, optional remote warm-up
- WASM files served from `lib/` directory

> **Implementation Details**: See [docs/transformer.md](docs/transformer.md) for full Transformers.js configuration, CSP setup, and model loading patterns.


## Retrieval: Default Hybrid + Reranking (Two‑Stage)

**Stage 1 — Candidate Generation (Hybrid)**:
- Run PostgreSQL full-text search (tsvector/tsquery) and pgvector similarity search in parallel
- Merge via RRF (Reciprocal Rank Fusion) with k=60: `rrf = 1/(k + rank)`
- Generate ~150-200 candidate pool for reranking

**Stage 2 — Reranking**:
- Compute weighted score: semantic (40%), text relevance (30%), recency (20%), popularity (10%)
- Normalize ts_rank (PostgreSQL TF-IDF) and cosine distances to [0, 1]
- Apply recency boost (exponential decay) and visit frequency (log-scaled)
- Return top N results (typically 20-50)

**Advanced Modes** (user-selectable):
- **Hybrid + Rerank** (default) - Full two-stage pipeline
- **Hybrid (RRF)** - Stage 1 only, no reranking
- **Text only** - PostgreSQL full-text search with ts_rank
- **Vector only** - Cosine similarity via pgvector

> **Implementation Details**: See [docs/pglite.md](docs/pglite.md) for complete search algorithms, RRF implementation, and reranking scoring formulas.


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
- **Two-stage chat search flow**:
  1. **Keyword extraction**: Chrome AI analyzes query to determine intent and extract search keywords
  2. **Enhanced search**: Uses extracted keywords for filtered hybrid search (if search query detected)
  3. **Response generation**: Chrome AI generates conversational response with links to relevant pages
- **Message persistence**: Chat history stored in PGlite with 200-message FIFO limit
- **Session management**: Uses `initialPrompts` for context, `append()` for dynamic search results

## Chrome AI Integration (Chat)

**API Usage**:
- Chrome 138+ global `LanguageModel` API (no fallback - requires Chrome AI availability)
- Keyword extraction with JSON Schema `responseConstraint` for structured output
- Session management: `LanguageModel.create({ initialPrompts, temperature, topK })`
- Quota tracking: monitors `inputUsage` vs `inputQuota`, recreates sessions when needed

**Chat Flow**:
1. Extract keywords with dedicated extraction session (low temperature, topK=1)
2. Search history only if query is search-related (based on `is_search_query` flag)
3. Generate response with conversation context + search results (if applicable)
4. Persist both user and assistant messages to PGlite

> **Implementation Details**: See [docs/chrome_api.md](docs/chrome_api.md) for Chrome AI integration patterns and [history_chat.js](chrome-extension/sidepanel/history_chat.js) for full chat flow.


## Debug Page (debug.html)

Comprehensive debugging and testing interface accessible via context menu ("AI History: Debug").

**Key Features**:
- **Site Permissions**: Check/grant host access for content extraction
- **Chrome AI Testing**: Keyword extraction, Summarizer API, full chat flow testing with production code
- **DB Explorer**: PostgreSQL query console with vector/FTS sample queries
- **Queue Management**: Monitor and control AI summarization queue (LISTEN/NOTIFY debugging)
- **Content Analysis**: Embedding status, search mode comparison, extraction statistics
- **System Monitoring**: Live log viewer with filtering and export capabilities

**Testing Philosophy**: Debug page uses actual production code from `sidepanel/` and `bridge/` directories. No duplicate implementations - ensures accurate testing of user experience.

> **See**: [debug.html](chrome-extension/debug.html) for complete interface layout and feature descriptions.


## Background and Offscreen Orchestration

**Service Worker** (`background.js`):
- Register side panel and context menu
- Create and manage single offscreen document instance
- Route messages between UI and offscreen document

**Offscreen Document** (`offscreen.js`):
- Initialize PGlite with pgvector extension
- Load Transformers.js embedding model (workers disabled for MV3)
- Expose message handlers: `ingestPage`, `search`, `embed`, `clearDb`, chat message operations
- Manage AI summarization queue with LISTEN/NOTIFY

> **Architecture**: All heavy processing (database, embeddings, AI) runs in offscreen document to avoid blocking UI. See [background.js](chrome-extension/background.js) and [offscreen.js](chrome-extension/offscreen.js) for implementation.


## State, Caching, and Persistence

**Chrome Storage** (`chrome.storage.local`):
- `searchMode` - Selected search mode (hybrid-rerank, hybrid-rrf, text, vector)
- `lastSidePanelPage` - Last active tab (search or chat)
- `aiPrefs` - AI preferences (enableReranker, enableRemoteWarm)

**Database Storage**:
- PGlite database persisted in IndexedDB (key: `ai-history-pglite`)
- Automatic persistence across browser sessions
- Model cache managed by Transformers.js

## UX Requirements

- Display favicon, title, URL, and summary/snippet for all results
- Show loading indicators during search and chat generation
- Include clickable links in chat responses when matches exist
- Persist and restore user preferences (search mode, scroll position, active tab)


## Error Handling and Fallbacks

**Search Fallbacks**:
- PostgreSQL FTS failure → ILIKE pattern matching
- pgvector unavailable → text-only mode with debug warning
- Transformers.js load failure → text-only modes with retry option

**Chrome AI Handling**:
- Extension requires Chrome AI availability (no graceful degradation)
- Clear error messages guide users to enable Chrome Canary AI flags
- Specific errors for: unavailability, quota exceeded, model downloading

> **See**: [docs/pglite.md](docs/pglite.md) and [docs/chrome_api.md](docs/chrome_api.md) for detailed error handling patterns.

## Coding Conventions

- **Language**: ES modules, type-safe JS with JSDoc where useful
- **Architecture**: Async/await, no main thread blocking, heavy work in offscreen
- **Modules**: Named exports preferred, small cohesive files
- **Logging**: Prefix with `[BG]`, `[OFFSCREEN]`, `[SEARCH]`, `[CHAT]`, `[DB]`
- **State**: Avoid global mutable state, centralize settings in `chrome.storage.local`

## Implementation References

For detailed implementation patterns, see:
- **[docs/pglite.md](docs/pglite.md)** - Database schema, vector search, RRF, hybrid reranking
- **[docs/transformer.md](docs/transformer.md)** - Transformers.js config, embeddings, CSP constraints
- **[docs/chrome_api.md](docs/chrome_api.md)** - Chrome AI integration, keyword extraction, chat flow
- **[constitution.md](constitution.md)** - Extension design principles and governance


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
