AI History Extension — Notes (Clean)

Current State
- Architecture: MV3 extension with background service worker, offscreen document for DB/ML, sidepanel UIs (Search, Chat), Debug page, and a content script for capture.
- Chrome AI: Chat uses Chrome’s Language Model only (no structured fallback). `AIBridge.initialize()` is strict and throws if unavailable.
- Embeddings: Local-first using bundled `Xenova/bge-small-en-v1.5-quantized`. Optional remote warm-up can hot-swap to `Xenova/bge-small-en-v1.5` when enabled.
- Database: Requires sqlite-vec (vec0, 384-dim) and FTS5. No LIKE/regular-table fallbacks.
- Permissions: On install, opens Search page to prompt user to grant all-sites. Sidepanel overlays can re-request if revoked.

Remote Warm-Up (Optional)
- Preference: `aiPrefs.enableRemoteWarm` (boolean, saved in `chrome.storage.local`).
- Behavior: Offscreen loads local model immediately; if enabled, it warms the remote model (HTTPS + Cache API) and hot-swaps when ready.
- Status API: `get-model-status` → `{ using: 'local'|'remote', warming: boolean, lastError: string|null }`.
- UI:
  - Search/Chat Advanced Options: toggle + status line with spinner during warm-up.
  - Debug Preferences: toggle + “Refresh” model status.

Transformers.js Configuration
- Local model path: `env.localModelPath = chrome.runtime.getURL('lib/models/')`.
- Default: `env.allowLocalModels = true`, `env.allowRemoteModels = false`, `env.useBrowserCache = false`.
- During warm-up only: temporarily set `allowRemoteModels = true`, `allowLocalModels = false`, `useBrowserCache = true` to fetch and cache HTTPS assets.

Model Packaging (Local)
- Place under: `chrome-extension/lib/models/Xenova/bge-small-en-v1.5-quantized/`
  - Files: `config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `preprocessor_config.json`, `vocab.txt` (if used)
  - ONNX: `onnx/model.onnx` and `onnx/model_quantized.onnx`
- Expose via `manifest.json` web_accessible_resources: `lib/models/**`.

Known Benign Logs
- sqlite3 OPFS warning about Atomics.wait: harmless (IndexedDB VFS is used).
- aiPrefs load debug on first run: harmless (defaults applied).

Open TODOs
- Review and remove legacy `globalThis.Summarizer` code path if not needed in Canary.
- Replace placeholder `quantize_config.json` with the upstream version if a tool depends on it.


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
