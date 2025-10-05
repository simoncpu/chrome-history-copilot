# ![Chrome History Copilot Icon](chrome-extension/icons/48.png "Browser Copilot Icon") Chrome History Copilot

A Chrome extension that makes your browsing history truly searchable and queryable using AI, while keeping everything private and running locally on your device.

## What it does

This Chrome extension captures and indexes your browser history locally, then lets you search through it using smart AI-powered techniques. You can either search directly or have conversations about your browsing history using Chrome's built-in AI.

## Key Features

- Smart search through your history using hybrid retrieval (combines keyword search + semantic similarity)
- Chat interface where you can ask questions about your browsing history and get AI-powered answers with links
- Multiple search modes: Hybrid+Rerank (default), Hybrid (RRF), Text-only, Vector-only
- Side panel UI with two modes:
  1. Search page (default) - search your history with different modes
  2. Chat page - conversational interface powered by Chrome's Prompt API
- Debug page for database management and troubleshooting
- Local‑first - no browsing data leaves your device. Optional model downloads can be enabled.

## How it works

The extension uses modern AI techniques to understand the meaning and context of web pages you visit:

- Captures your browser history automatically as you browse
- Indexes page content using both traditional keyword search and AI embeddings for semantic understanding
- Stores everything locally using PGlite (PostgreSQL in WASM) with pgvector for vector similarity search
- Searches using hybrid retrieval that combines the best of keyword matching and AI similarity
- Answers questions about your history using Chrome's on-device AI (Chrome Canary required)

## Privacy

Everything runs locally by default. No browsing data is ever transmitted. If you opt in to use a larger embedding model, the extension may download static model files from trusted hosts (see Network Use below). All processing of your browsing history remains on device.

## Requirements

- Chrome Canary 143.0.7448.0 or later
- Chrome AI flags enabled (see [HOWTO_CANARY.md](HOWTO_CANARY.md) for detailed setup)

## Installation

### Step 1: Download the Extension

Download the latest release from the [Releases page](https://github.com/simoncpu/chrome-history-copilot/releases):
- Download `history-copilot-v*.zip` from the latest release
- Extract the zip file to a location on your computer

### Step 2: Enable Chrome AI Features

Follow the complete setup guide in [HOWTO_CANARY.md](HOWTO_CANARY.md), or quick setup:

1. Open Chrome Canary and navigate to `chrome://flags`
2. Enable the following flags:
   - `chrome://flags/#optimization-guide-on-device-model` → **Enabled**
   - `chrome://flags/#prompt-api-for-gemini-nano` → **Enabled**
   - `chrome://flags/#summarization-api-for-gemini-nano` → **Enabled**
3. Restart Chrome Canary

### Step 3: Load the Extension

1. Open `chrome://extensions` in Chrome Canary
2. Enable "Developer mode" using the toggle in the top-right corner
3. Click "Load unpacked"
4. Select the extracted `chrome-extension` folder from Step 1
5. The extension icon should appear in your toolbar

### Step 4: Grant Permissions (Important)

The extension needs site access to extract page content:
- Click the extension icon and go to the Debug page
- Use "Grant All Sites Access" or grant access per-site as needed
- Alternatively, right-click the extension icon → "This can read and change site data" → "On all sites"

### Step 5: Start Using

Click the extension icon to open the side panel and start searching your history. Your browsing history becomes a searchable, queryable knowledge base that you can interact with naturally.

## Creating a Release (For Maintainers)

To create a new release:
```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions will automatically create a release with the zipped extension.

## Why Chrome Canary?

The extension uses Chrome's on‑device AI APIs (Prompt/Language Model and Summarizer), which are experimental and available in Chrome Canary behind feature flags. Without Canary, chat and summarization features won't be available. Follow the setup guide in [HOWTO_CANARY.md](HOWTO_CANARY.md).

## Network Use (Optional)

This extension is local‑first. If you enable the “Use larger remote model (warm in background)” option, the extension may fetch and cache model artifacts from:

- https://huggingface.co
- https://*.huggingface.co
- https://hf.co
- https://*.hf.co
- https://cdn.jsdelivr.net

Notes:
- Only static model files are downloaded. No browsing history, prompts, or user data are uploaded.
- Files are cached in the browser for offline use after the first warm‑up.
- Favicon thumbnails are loaded from Google’s favicon service (`https://www.google.com/s2/favicons`) using only the site hostname.
- UI fonts: the side panel references Google Fonts in CSS. You can remove that import for a stricter local‑only UI; it is not required for functionality.

## License

MIT License - see [LICENSE](LICENSE) for details

## Author

Simon Cornelius P. Umacob <df51if9yh@mozmail.com>
