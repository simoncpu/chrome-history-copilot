/**
 * Content script: extracts visible text from the current page on demand.
 * Injected into all http/https pages via manifest.json content_scripts.
 */

(function () {
  'use strict';

  /**
   * Pick the most relevant root element for content extraction
   */
  function pickRoot() {
    return (
      document.querySelector('main, article, [role="main"], #main, .main, .content, #content') ||
      document.body ||
      document.documentElement
    );
  }

  /**
   * Extract visible text from the page
   */
  function extractVisibleText() {
    try {
      const root = pickRoot();
      // innerText respects CSS visibility and approximates what the user sees
      let text = root ? root.innerText || '' : '';

      // Normalize whitespace
      text = text.replace(/\s+/g, ' ').trim();

      // Cap to a reasonable size to avoid oversized messages
      const MAX_CHARS = 200_000;
      if (text.length > MAX_CHARS) {
        text = text.slice(0, MAX_CHARS) + '...';
      }

      return text;
    } catch (e) {
      console.warn('[CONTENT-EXTRACTOR] Failed to extract text:', e);
      return '';
    }
  }

  /**
   * Attempt to summarize text using Chrome AI Summarizer
   */
  async function trySummarize(text) {
    try {
      if (typeof window === 'undefined' || !window.ai?.summarizer) return null;

      // Attempt creation; may fail if user activation is required
      let summarizer;
      try {
        summarizer = await window.ai.summarizer.create({
          type: 'key-points',
          length: 'medium',
          format: 'plain-text',
          language: 'en',
          outputLanguage: 'en'
        });
      } catch (e) {
        console.warn('[CONTENT-EXTRACTOR] Failed to create summarizer:', e);
        return null;
      }

      try {
        // Limit input size for summarizer
        const MAX = 32000;
        const input = text.length > MAX ? text.slice(0, MAX) + '...' : text;

        const summary = await summarizer.summarize(input, {
          context: `Web page titled "${document.title || ''}" from ${location.hostname}`,
          language: 'en',
          outputLanguage: 'en'
        });

        return typeof summary === 'string' ? summary : null;
      } finally {
        try {
          if (summarizer && summarizer.destroy) {
            summarizer.destroy();
          }
        } catch (e) {
          console.warn('[CONTENT-EXTRACTOR] Failed to destroy summarizer:', e);
        }
      }
    } catch (e) {
      console.warn('[CONTENT-EXTRACTOR] Summarization failed:', e);
      return null;
    }
  }

  /**
   * Handle messages from background script
   */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Handle explicit content extraction request
    if (msg && msg.type === 'getPageContent') {
      try {
        const payload = {
          url: location.href,
          title: document.title || '',
          text: extractVisibleText(),
          domain: location.hostname,
          timestamp: Date.now()
        };
        sendResponse(payload);
      } catch (e) {
        console.error('[CONTENT-EXTRACTOR] Failed to get page content:', e);
        sendResponse({ error: e.message });
      }
      return true; // Synchronous response
    }

    // Handle auto-capture request (triggered on navigation)
    if (msg && msg.type === 'autoCapture') {
      (async () => {
        try {
          const text = extractVisibleText();

          // Skip trivial pages
          if (!text || text.length < 100) {
            console.log('[CONTENT-EXTRACTOR] Skipping trivial page:', location.href);
            return;
          }

          // Attempt summarization (may fail due to user activation requirements)
          const summary = await trySummarize(text);

          const payload = {
            url: location.href,
            title: document.title || '',
            domain: location.hostname,
            // Store a bounded amount of text to keep storage reasonable
            text: text.length > 200000 ? text.slice(0, 200000) + '...' : text,
            summary: summary || null,
            summaryType: summary ? 'key-points' : null,
            aiModel: summary ? 'chrome-ai-summarizer' : null,
            generatedAt: new Date().toISOString(),
            timestamp: Date.now()
          };

          // Send captured content to background for storage
          chrome.runtime.sendMessage({
            type: 'capturedContent',
            payload
          }, () => {
            // Ignore errors (background might not be available)
            void chrome.runtime.lastError;
          });

        } catch (e) {
          console.error('[CONTENT-EXTRACTOR] Auto-capture failed:', e);
        }
      })();

      // No response required for auto-capture
      return false;
    }

    return false;
  });

  console.log('[CONTENT-EXTRACTOR] Content script loaded for:', location.href);
})();