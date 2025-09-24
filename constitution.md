# Bare-Minimum Chrome Extension Constitution

## Core Principles

### I. Minimal Scope
Build for one clear user outcome. Ship only essential files. Prefer plain JS/HTML/CSS. Avoid frameworks and build steps unless strictly required (YAGNI).

### II. Least Permission
Request only the permissions needed for the core feature. Use specific `host_permissions` instead of wildcards. No remote code, `eval`, or broad `*://*/*` access.

### III. MV3-First
Target Manifest V3. Use a background Service Worker where needed. Prefer declarative APIs. Avoid persistent pages or unnecessary long-running scripts.

### IV. Privacy By Default (Local‑First)
No data leaves the device by default. The project is local‑first. Optional network fetches are allowed only when explicitly enabled by the user and only for static artifacts (e.g., model files). Never transmit browsing history or user prompts. Document any endpoints and purpose in the `README`.

### V. Simple Build & Release
No build step by default. Keep a flat, small codebase. Load unpacked during development. Zip the folder for release and bump `manifest.json` version.

## Project Constraints

- Files
  - `manifest.json` (v3, single source of truth for version/permissions)
  - Optional: `service_worker.js` (background), `content.js` (content script)
  - Optional UI: `popup.html`, `popup.js`, minimal CSS
  - Icons: `icons/16.png`, `icons/48.png`, `icons/128.png`
- Manifest defaults
  - `manifest_version: 3`
  - Use `action` only if popup exists; omit otherwise
  - Keep `permissions` empty unless required; use precise `host_permissions`
  - Avoid `web_accessible_resources` unless absolutely necessary
- Coding
  - Plain ES modules where helpful; no transpilation
  - Keep files small and readable; minimal comments explaining intent
- Security & CSP
  - No inline scripts in HTML; use separate JS files
  - No remote code execution or dynamic imports from external origins
- Accessibility (if UI exists)
  - Keyboard navigable popup; clear labels; sufficient contrast

## Development Workflow

- Branching
  - Work on `main` or short-lived feature branches; keep PRs small
- Commit/Review
  - Descriptive commit messages; one reviewer when possible
- Manual test checklist (before release)
  - Load unpacked via `chrome://extensions` and check for errors
  - Verify the core feature on target page(s)
  - Confirm permission prompts are expected and minimal
  - Check background/service worker and content script logs for errors
  - If popup/options exist: open, tab through, basic a11y sanity
- Release
  - Update `manifest.json: version`
  - Zip the extension folder (exclude dev-only files)
  - Tag the release and note a one-line change summary

## Governance

- This constitution guides decisions; simpler options and least permissions win by default.
- Exceptions must be documented briefly in `README` with rationale.
- Amendments require a PR updating this file and a minor version bump here.

**Version**: 1.0.0 | **Ratified**: 2025-09-20 | **Last Amended**: 2025-09-20
