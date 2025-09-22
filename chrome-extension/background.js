/**
 * AI-Powered Browser History - Background Script (Service Worker)
 * Handles extension lifecycle, side panel setup, context menu, and offscreen orchestration
 */

// Extension installation and startup
chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});

// Note: do not create context menu on startup to avoid duplicate id errors
// Service worker restarts don't remove menus; onInstalled is sufficient.

// Side panel management
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
    console.log('[BG] Side panel opened');
  } catch (error) {
    console.error('[BG] Failed to open side panel:', error);
  }
});

// Context menu setup
function setupContextMenu() {
  // Create menu once; ignore duplicate-id error if any
  chrome.contextMenus.create({
    id: 'ai-history-debug',
    title: 'AI History: Debug',
    contexts: ['page', 'action']
  }, () => {
    // Swallow duplicate-id errors to keep logs clean in dev
    void chrome.runtime.lastError;
  });
}

// Context menu click handler
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'ai-history-debug') {
    chrome.tabs.create({ url: chrome.runtime.getURL('debug.html') });
  }
});

// Offscreen document management
let offscreenCreated = false;

async function ensureOffscreenDocument() {
  if (offscreenCreated) {
    return;
  }

  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length > 0) {
      offscreenCreated = true;
      return;
    }

    await chrome.offscreen.createDocument({
      // Disable OPFS attempts in offscreen (main thread) to avoid benign warnings
      url: 'offscreen.html?opfs-disable',
      reasons: ['DOM_SCRAPING', 'LOCAL_STORAGE'],
      justification: 'SQLite database operations and ML model processing'
    });

    offscreenCreated = true;
    console.log('[BG] Offscreen document created');
  } catch (error) {
    console.error('[BG] Failed to create offscreen document:', error);
  }
}

// Message routing between UI and offscreen
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[BG] Message received:', message.type, 'from:', sender.id);

  // Handle captured content from content scripts
  if (message.type === 'capturedContent') {
    handleCapturedContent(message.payload, sendResponse);
    return true; // Async response
  }

  // Handle requests for captured content queue (from offscreen)
  if (message.type === 'getCapturedQueue') {
    getCapturedQueue(sendResponse);
    return true; // Async response
  }

  // Handle deletion of captured entries (from offscreen)
  if (message.type === 'deleteCapturedEntries') {
    deleteCapturedEntries(message.urls, sendResponse);
    return true; // Async response
  }

  // Handle captured summary updates (from content script)
  if (message.type === 'capturedSummary') {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const resp = await chrome.runtime.sendMessage({
          type: 'update-summary',
          data: message.payload
        });
        sendResponse(resp);
      } catch (e) {
        console.warn('[BG] Failed to forward captured summary:', e);
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  // Route messages to offscreen document
  if (message.target === 'offscreen') {
    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage(message).then(sendResponse);
    });
    return true; // Keep message channel open for async response
  }

  // Define messages that should be forwarded to offscreen document
  const offscreenMessages = [
    'ingest-page', 'search', 'embed', 'clear-db', 'get-stats',
    'execute-sql', 'clear-model-cache', 'export-db', 'import-db', 'update-summary'
  ];

  if (offscreenMessages.includes(message.type)) {
    // Forward to offscreen document
    ensureOffscreenDocument().then(async () => {
      try {
        const response = await chrome.runtime.sendMessage(message);
        sendResponse(response);
      } catch (error) {
        console.error('[BG] Failed to forward message to offscreen:', error);
        sendResponse({ error: error.message });
      }
    });
    return true; // Keep message channel open for async response
  }

  // Handle background-specific messages
  switch (message.type) {
    case 'ping':
      sendResponse({ status: 'ok', timestamp: Date.now() });
      break;

    case 'get-tab-info':
      if (sender.tab) {
        sendResponse({
          tabId: sender.tab.id,
          url: sender.tab.url,
          title: sender.tab.title
        });
      }
      break;

    case 'extractPageContent':
      extractPageContent(message.url, sendResponse);
      return true; // Async response

    default:
      console.warn('[BG] Unknown message type:', message.type);
      sendResponse({ error: 'Unknown message type' });
  }
});

// History ingestion triggers
chrome.history.onVisited.addListener((historyItem) => {
  // Skip internal URLs
  if (!isInternalUrl(historyItem.url)) {
    console.log('[BG] Page visited:', historyItem.url);
    // Queue for ingestion
    queuePageForIngestion(historyItem);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && !isInternalUrl(tab.url)) {
    console.log('[BG] Tab completed loading:', tab.url);
    // Trigger content extraction and ingestion
    queuePageForIngestion({
      url: tab.url,
      title: tab.title,
      visitTime: Date.now(),
      tabId
    });
  }
});

// Auto-capture on navigation completion
chrome.webNavigation.onCompleted.addListener(({ tabId, url, frameId }) => {
  try {
    if (frameId !== 0) return; // only top-level frames
    if (!/^https?:\/\//.test(url)) return; // only http/https

    console.log('[BG] Navigation completed:', url);

    // Send auto-capture message to content script
    chrome.tabs.sendMessage(tabId, { type: 'autoCapture' }, () => {
      // Ignore errors when content script isn't present or page is restricted
      void chrome.runtime.lastError;
    });
  } catch (e) {
    // Ignore errors in navigation handler
  }
}, { url: [{ schemes: ['http', 'https'] }] });

// Content extraction using chrome.scripting API
async function extractPageContent(url, sendResponse) {
  try {
    // Find tab with the URL
    const tabs = await chrome.tabs.query({ url: url });

    if (tabs.length === 0) {
      console.log('[BG] No open tab found for URL:', url);
      sendResponse({ error: 'No open tab found for URL' });
      return;
    }

    const tab = tabs[0];

    // Send message to content script with a small retry to avoid race conditions
    try {
      const response = await sendMessageWithRetry(tab.id, { type: 'getPageContent' });
      sendResponse(response);
    } catch (e) {
      console.warn('[BG] Content script extraction failed, falling back to scripting:', e.message);
      try {
        const fallback = await extractViaScripting(tab);
        sendResponse(fallback);
      } catch (e2) {
        console.error('[BG] Fallback extraction failed:', e2.message);
        sendResponse({ error: e2.message });
      }
    }

  } catch (error) {
    console.error('[BG] Content extraction error:', error);
    sendResponse({ error: error.message });
  }
}

// Helper: tabs.sendMessage with retry when content script isn't ready yet
async function sendMessageWithRetry(tabId, message, attempts = 3, delayMs = 300) {
  const shouldRetry = (msg) => /Receiving end does not exist|Could not establish connection/i.test(msg || '');

  for (let i = 0; i < attempts; i++) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
    } catch (e) {
      if (i === attempts - 1 || !shouldRetry(e.message)) {
        throw e;
      }
      await new Promise((r) => setTimeout(r, delayMs * Math.pow(2, i)));
    }
  }
}

// Handle captured content from content scripts
async function handleCapturedContent(payload, sendResponse) {
  try {
    console.log('[BG] Captured content for:', payload.url, {
      textLen: (payload.text || '').length,
      hadSummary: !!payload.summary,
      summaryLen: payload.summary ? payload.summary.length : 0
    });

    const key = 'capturedContentByUrl';
    const store = await chrome.storage.local.get(key);
    const map = store[key] || {};

    // Keep the latest capture per URL
    map[payload.url] = payload;
    await chrome.storage.local.set({ [key]: map });

    // Notify side panel to ingest immediately if open
    try {
      const tabs = await chrome.tabs.query({});
      const searchPanelUrl = chrome.runtime.getURL('sidepanel/history_search.html');
      const chatPanelUrl = chrome.runtime.getURL('sidepanel/history_chat.html');

      for (const tab of tabs) {
        if (tab.url === searchPanelUrl || tab.url === chatPanelUrl) {
          chrome.tabs.sendMessage(tab.id, { type: 'ingestCaptured' }, () => void chrome.runtime.lastError);
        }
      }
    } catch (e) {
      // Ignore notification errors
    }

    // Trigger offscreen ingestion
    try {
      await ensureOffscreenDocument();

      // Send payload directly for immediate ingestion
      chrome.runtime.sendMessage({
        type: 'ingest-captured-payload',
        data: payload
      }).then((resp) => {
        if (resp?.error) {
          console.warn('[BG] Offscreen direct ingest error:', resp.error);
        } else {
          console.log('[BG] Offscreen direct ingest response:', resp?.status || resp);
        }
      }).catch(() => void chrome.runtime.lastError);

      // Also send generic ingest signal for any queued items
      chrome.runtime.sendMessage({
        type: 'ingest-captured-queue'
      }).then((resp) => {
        if (resp?.error) {
          console.warn('[BG] Offscreen queue ingest error:', resp.error);
        } else {
          console.log('[BG] Offscreen queue ingest response:', resp?.status || resp);
        }
      }).catch(() => void chrome.runtime.lastError);

    } catch (e) {
      console.warn('[BG] Offscreen ingestion not available:', e);
    }

    sendResponse({ success: true });
  } catch (error) {
    console.error('[BG] Failed to handle captured content:', error);
    sendResponse({ error: error.message });
  }
}

// Get captured content queue for offscreen
async function getCapturedQueue(sendResponse) {
  try {
    const key = 'capturedContentByUrl';
    const store = await chrome.storage.local.get(key);
    const map = store[key] || {};
    sendResponse({ success: true, map });
  } catch (error) {
    console.error('[BG] Failed to get captured queue:', error);
    sendResponse({ error: error.message });
  }
}

// Delete captured entries after processing
async function deleteCapturedEntries(urls, sendResponse) {
  try {
    const key = 'capturedContentByUrl';
    const store = await chrome.storage.local.get(key);
    const map = store[key] || {};

    let removed = 0;
    for (const url of urls) {
      if (map[url]) {
        delete map[url];
        removed++;
      }
    }

    await chrome.storage.local.set({ [key]: map });
    console.log('[BG] Deleted', removed, 'captured entries');
    sendResponse({ success: true, removed });
  } catch (error) {
    console.error('[BG] Failed to delete captured entries:', error);
    sendResponse({ error: error.message });
  }
}

// Page ingestion queue (legacy support)
const ingestionQueue = [];
let isProcessingQueue = false;
const recentlyProcessed = new Set(); // Track recently processed URLs

function isInternalUrl(url) {
  // Skip internal Chrome/Edge pages and extension pages
  return url.startsWith('chrome://') ||
         url.startsWith('chrome-extension://') ||
         url.startsWith('edge://') ||
         url.startsWith('about:') ||
         url.startsWith('file://');
}

async function queuePageForIngestion(pageInfo) {
  // Skip internal URLs that we can't extract content from
  if (isInternalUrl(pageInfo.url)) {
    return;
  }

  // Skip if we've recently processed this URL (dedupe within 30 seconds)
  const urlKey = pageInfo.url;
  if (recentlyProcessed.has(urlKey)) {
    return;
  }

  // Mark as recently processed
  recentlyProcessed.add(urlKey);
  setTimeout(() => recentlyProcessed.delete(urlKey), 30000); // Clean up after 30s

  ingestionQueue.push(pageInfo);

  if (!isProcessingQueue) {
    processIngestionQueue();
  }
}

async function processIngestionQueue() {
  if (isProcessingQueue || ingestionQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;

  try {
    await ensureOffscreenDocument();

    console.log('[BG] Processing ingestion queue. Count:', ingestionQueue.length);
    while (ingestionQueue.length > 0) {
      const pageInfo = ingestionQueue.shift();
      console.log('[BG] Ingesting page from queue:', pageInfo.url);

      try {
        // Try to extract real content if possible
        const tabs = await chrome.tabs.query({ url: pageInfo.url });
        let extractedContent = null;

        console.log('[BG] tabs.query result count:', tabs.length, 'for URL:', pageInfo.url);
        // Check host permission for this origin to clarify why extraction may fail
        try {
          const origin = new URL(pageInfo.url).origin + '/*';
          const hasPerm = await chrome.permissions.contains({ origins: [origin] });
          console.log('[BG] Host permission', hasPerm ? 'granted' : 'missing', 'for', origin);
          if (!hasPerm) {
            console.warn('[BG] No host permission for origin; content script and scripting extraction may be blocked unless user grants access.');
          }
        } catch (permErr) {
          console.warn('[BG] Host permission check failed:', permErr?.message || permErr);
        }
        if (tabs.length > 0) {
          try {
            extractedContent = await sendMessageWithRetry(tabs[0].id, { type: 'getPageContent' });
            if (extractedContent && !extractedContent.error) {
              console.log('[BG] Content script extracted:', {
                url: pageInfo.url,
                title: extractedContent.title,
                textLen: (extractedContent.text || '').length
              });
            }
          } catch (e) {
            console.warn('[BG] Failed to extract via content script, trying scripting for:', pageInfo.url, e.message);
            try {
              extractedContent = await extractViaScripting(tabs[0]);
              if (extractedContent && !extractedContent.error) {
                console.log('[BG] Scripting extracted:', {
                  url: pageInfo.url,
                  title: extractedContent.title,
                  textLen: (extractedContent.text || '').length
                });
              }
            } catch (e2) {
              console.warn('[BG] Fallback scripting extraction failed:', e2.message);
            }
          }
        }

        // Send to offscreen for processing
        console.log('[BG] Sending ingest-page to offscreen:', {
          url: pageInfo.url,
          hasExtracted: !!extractedContent,
          extractedLen: extractedContent ? (extractedContent.text || '').length : 0
        });
        const response = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'ingest-page',
          data: {
            ...pageInfo,
            extractedContent
          }
        });

        console.log('[BG] Offscreen ingest response:', response);
        if (response?.error) {
          console.error('[BG] Ingestion failed:', response.error);
        } else {
          console.log('[BG] Page ingested successfully:', pageInfo.url);
        }
      } catch (error) {
        console.error('[BG] Failed to process page:', pageInfo.url, error);
      }
    }
  } finally {
    isProcessingQueue = false;
  }
}

// Fallback extractor using chrome.scripting.executeScript
async function extractViaScripting(tab) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: false },
    func: () => {
      const pick = () => document.querySelector('main, article, [role="main"], #main, .main, .content, #content') || document.body || document.documentElement;
      const root = pick();
      let text = root ? (root.innerText || '') : '';
      text = (text || '').replace(/\s+/g, ' ').trim();
      const MAX = 200000;
      if (text.length > MAX) text = text.slice(0, MAX) + '...';
      return {
        url: location.href,
        title: document.title || '',
        text,
        domain: location.hostname,
        timestamp: Date.now()
      };
    }
  });
  return result;
}
