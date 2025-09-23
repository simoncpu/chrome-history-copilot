AI History Extension — Codebase Review Notes

Scope: chrome-extension/* and root docs. Focus on MV3 extension structure, Chrome AI APIs usage, embeddings/SQLite pipeline, and UX.

Summary
- Solid MV3 scaffolding: background SW + offscreen doc for heavy work, side panel UIs, debug page, content script capture.
- Hybrid search is thoughtfully implemented with FTS5 + sqlite-vec (with fallback when vec0 isn’t available).
- Chrome AI APIs are integrated (Summarizer + Language Model) with graceful fallbacks; Transformers.js embedding pipeline configured for MV3 constraints.
- A few missing features and rough edges remain around permissions UX, CSP, import/export, reranker, and minor API details.

Status Updates (Applied)
- Fixed offscreen reasons: replaced unsupported `LOCAL_STORAGE` with `IFRAME_SCRIPTING` in `chrome-extension/background.js`.
- Side panel permissions onboarding: implemented overlay logic and buttons in `chrome-extension/sidepanel/history_search.js` and `chrome-extension/sidepanel/history_chat.js` to request all-sites host access and open extension settings.
- Summarizer options consistency: added `{ language: 'en', outputLanguage: 'en' }` defaults in `chrome-extension/bridge/ai-bridge.js` summarizer session creation.
- Row mapping robustness: changed SELECTs to explicit column lists and passed column names to `rowToObject` in `chrome-extension/offscreen.js` for text, rank-fallback, LIKE, and vector searches.
- Debug UI cleanup: removed Database Size stat and Export/Import controls from `chrome-extension/debug.html` and corresponding logic from `chrome-extension/debug.js`.
- Removed unused client: deleted `chrome-extension/bridge/db-bridge.js`.
- Docs drift corrected: updated references in `technical_challenges_chrome_api.md` to current files (`bridge/ai-bridge.js`, `content-extractor.js`, `sidepanel/history_chat.js`).

2025-09-23 — Chrome AI + Fallback Cleanup
- Phase 1 (AI-only):
  - Made `AIBridge.initialize()` strict: throws if `window.ai.languageModel` is unavailable (chrome-extension/bridge/ai-bridge.js:17–43).
  - Removed chat structured-response fallback and always use Chrome AI for chat:
    - Deleted `generateStructuredResponse(...)` and fallback call path (chrome-extension/sidepanel/history_chat.js).
    - Removed unused `generateStructuredResponse(...)` in bridge (chrome-extension/bridge/ai-bridge.js).
  - Updated chat status messages to no longer mention “using fallback” (AI must be available).

- Phase 2 (assumptions and simplifications):
- Transformers.js model: assume a bundled local model `Xenova/bge-small-en-v1.5-quantized`.
  - Configure Transformers env to allow local, disallow remote; initialize pipeline with that model.
  - Removed deterministic mock embedding fallback (chrome-extension/offscreen.js:initializeEmbeddings).
  - Set `env.localModelPath = chrome.runtime.getURL('lib/models/')` and exposed `lib/models/**` via web_accessible_resources.
  - SQLite features: assume sqlite-vec and FTS5 are always available.
    - Always create `pages` as `vec0` virtual table and `pages_fts` as FTS5; removed regular-table/LIKE fallbacks.
    - Simplified search paths: no FTS/LIKE fallback; no vec-unavailable branches.
    - Cleaned stats/clear paths accordingly (chrome-extension/offscreen.js).
- Host permissions: assume all-sites granted on install; if revoked later, side panel onboards again.
    - NOTE: Chrome requires a user gesture for `chrome.permissions.request`. Instead of requesting on install, we now open the search page to prompt the user to grant access via the overlay button (chrome-extension/background.js).
    - Sidepanel onboarding overlays remain to re-request if permissions are revoked.
  - Offscreen summarization legacy API:
    - Kept the `globalThis.Summarizer` fallback but marked with `TODO(ai-canary)` to revisit/removal (chrome-extension/offscreen.js).

Notes on Bundling the Embedding Model
- The code assumes `Xenova/bge-small-en-v1.5-quantized` is packaged with the extension and accessible to Transformers.js as a local model.
- env.allowLocalModels=true and env.allowRemoteModels=false are set. Ensure model files are placed where Transformers.js can resolve them from extension URLs (e.g., under `lib/models/...`) and that `web_accessible_resources` includes the paths if needed.

Assumptions Going Forward
- Chrome Canary with Chrome AI APIs enabled (window.ai.languageModel and summarizer available=readily in extension pages).
- Local embedding model is present and loadable; no remote fetch.
- sqlite-vec and FTS5 present in the bundled SQLite build.
- On install, user grants all-sites access (requested in background). If permissions get revoked, sidepanel overlays handle re-request.

Key Gaps / Missing Pieces
- Host-permissions onboarding in side panel — DONE
  - Implemented permission check for all-sites access and overlay button wiring.

- Offscreen createDocument reasons — DONE
  - Replaced with supported `['DOM_SCRAPING','IFRAME_SCRIPTING']`.

- Database export/import — UI OMITTED
  - Removed export/import controls from Debug UI; backend stubs remain unchanged.

- Optional reranker not implemented
  - File: chrome-extension/offscreen.js (aiPrefs.enableReranker exists)
  - The “cross-encoder reranker” path is stubbed. Either implement a lightweight cross-encoder (Transformers.js) behind the toggle, or hide the toggle until supported.

- Debug ‘dbSize’ stat — UI OMITTED
  - Removed the stat card and assignment code.

Chrome AI API Usage (Improvements)
- Summarizer options consistency — DONE
  - Added language/outputLanguage defaults in `bridge/ai-bridge.js`.

- Language Model session options
  - File: chrome-extension/bridge/ai-bridge.js
  - Options for ai.languageModel.create don’t currently include language parameters (usually fine), but ensure your defaults (systemPrompt, temperature, topK) follow the latest API guidance and consider exposing more knobs if needed.

- User activation/context
  - Offscreen summarization (offscreen.js trySummarizeOffscreen) guards capability and gracefully returns null. Good. Keep in mind some Chrome builds still require user activation even when capabilities() says ‘readily’; you already handle fallbacks.

CSP and External Resources
- Google Fonts import in side panel CSS
  - File: chrome-extension/sidepanel/styles.css
  - @import pulls from fonts.googleapis.com; current CSP for extension_pages does not include style-src/font-src for those domains, and remote fonts undermine “local-first”. Recommend removing the import and using system fonts (already listed in font-family) or bundling fonts locally and updating CSP accordingly.

- Connect-src domains
  - File: chrome-extension/manifest.json
  - connect-src includes huggingface.co, *.huggingface.co, hf.co, *.hf.co, and cdn.jsdelivr.net (good coverage). If you remove remote fonts and keep models remote-optional, this set remains minimal and aligned with usage.

Permissions and Host Access
- Content script vs. optional host permissions
  - File: chrome-extension/manifest.json
  - You rely on optional_host_permissions for http/https; content scripts won’t run until host access is granted. Background and debug flows request origins when needed (good). Just surface this clearly in the side panel UX via the permissions overlay mentioned above.

- Scripting fallback
  - File: chrome-extension/background.js
  - processIngestionQueue requests per-origin host permission if needed before using chrome.scripting.executeScript. This is correct use of optional_host_permissions.

Embeddings and SQLite
- sqlite-vec availability and fallback
  - File: chrome-extension/offscreen.js
  - Creation of vec0 table is wrapped in try/catch with fallback to regular tables + page_embeddings BLOBs. Good defensive design.

- FTS5 availability
  - File: chrome-extension/offscreen.js
  - FTS5 creation is guarded. Good.

- rowToObject robustness — DONE
  - Explicit column lists + provided names ensure stable keys in search results.

Message/RPC Structure
- Unused db-bridge client — REMOVED
  - Deleted bridge/db-bridge.js to reduce confusion.

UX and Side Panel
- Search/chat toggling and state
  - Files: chrome-extension/sidepanel/history_search.js, chrome-extension/sidepanel/history_chat.js
  - Flows are clean. Consider: (1) show a small inline tip if vector features are unavailable (fallback-only), (2) expose a control to toggle “allow cloud model” (via aiPrefs) from the side panel, not just debug.

- Link handling and snippets
  - Files: chrome-extension/sidepanel/history_search.js, chrome-extension/sidepanel/history_chat.js
  - Good linkification and snippet trimming. Safe escaping is used before injecting HTML in chat response rendering (escapeHtml + minimal markdown). Reasonable and safe.

Background/Offscreen Lifecycle
- Offscreen context check
  - File: chrome-extension/background.js
  - Uses chrome.runtime.getContexts to avoid duplicate creation. Good. Replace unsupported reason value as noted earlier.

- Queue deduping and throttling
  - File: chrome-extension/background.js
  - recentlyProcessed set dedupes URLs for 30s. Good for avoiding storms.

Privacy and Local-First
- Model downloads vs. README claims
  - Files: README.md, chrome-extension/offscreen.js
  - Current embedding pipeline defaults to allowRemoteModels=true which may fetch from Hugging Face. This conflicts with “No external dependencies required” messaging. Consider: default allowRemoteModels=false and add a clear “enable cloud model fetch” toggle in debug (already exists) or side panel.

Packaging and Docs
- Packaging/release
  - Add a small build script to zip chrome-extension/ and bump manifest version. Keep CHANGELOG or Release notes.

- Docs drift
  - File: technical_challenges_chrome_api.md
  - References paths (chrome-extension/js/chrome-ai.js, summary-manager.js) that don’t exist in this repo. Update doc references to current files (bridge/ai-bridge.js, content-extractor.js, offscreen.js, history_chat.js).

Concrete Fix Suggestions (Shortlist)
- Show permissions overlay in side panel pages
  - history_search.js and history_chat.js: on load, check all-sites or current-origin host permissions; if missing, show overlay and wire buttons to chrome.permissions.request and chrome://extensions page.

- Fix offscreen reasons
  - background.js ensureOffscreenDocument(): replace 'LOCAL_STORAGE' with a valid OffscreenReason (e.g., 'IFRAME_SCRIPTING').

- Remove Google Fonts import
  - sidepanel/styles.css: remove @import; rely on system fonts listed in font-family.

- Summarizer session language options
  - bridge/ai-bridge.js: include { language: 'en', outputLanguage: 'en' } in createSummarizerSession defaults; pass through to summarize if applicable.

- Strengthen row mapping
  - offscreen.js: prefer stmt.get({}) for SELECT queries used by search paths, or pass an explicit column name array to rowToObject to guarantee keys (id, url, title, snippet, distance, etc.).

- Optional: unify bridge pattern
  - Either remove bridge/db-bridge.js or implement corresponding requestId/response wiring in background/offscreen and adopt it in UI. Current direct messaging works fine; removing reduces confusion.

Nice-to-Haves / Next Steps
- Implement real export/import (VFS snapshot or JSON import/export) in offscreen.js.
- Add a compact status banner when embedding model is unavailable (vector-only modes disabled) to set expectations.
- Gate reranker behind device capability heuristics (and a toggle) if you implement it.
- Add a script to compute approximate DB size for debug stats.

Notable Files Touched During Review
- chrome-extension/manifest.json: MV3 config, CSP, optional_host_permissions.
- chrome-extension/background.js: side panel open, offscreen orchestration, capture/ingestion queue.
- chrome-extension/offscreen.js: DB schema, embeddings init, hybrid search, summarization fallback.
- chrome-extension/content-extractor.js: page text capture, best-effort summarization.
- chrome-extension/bridge/ai-bridge.js: Chrome AI bridge, sessions and prompts.
- chrome-extension/sidepanel/history_search.* and history_chat.*: UIs and message flows.
- chrome-extension/debug.*: DB explorer, prefs, permissions helpers.
