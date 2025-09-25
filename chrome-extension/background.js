/**
 * AI-Powered Browser History - Background Script (Service Worker)
 * Handles extension lifecycle, side panel setup, context menu, and offscreen orchestration
 */

// Extension installation and startup
chrome.runtime.onInstalled.addListener(async (details) => {
  setupContextMenu();

  // Open welcome page for new installations and major updates
  if (details.reason === 'install' ||
      (details.reason === 'update' && details.previousVersion !== chrome.runtime.getManifest().version)) {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
      console.log('[BG] Welcome page opened for onboarding');
    } catch (e) {
      console.warn('[BG] Failed to open welcome page:', e?.message || e);
    }
  }
});

// Note: do not create context menu on startup to avoid duplicate id errors
// Service worker restarts don't remove menus; onInstalled is sufficient.

// Side panel management
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
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
let offscreenCreationPromise = null;

async function ensureOffscreenDocument() {
  // If we're already in the process of creating an offscreen document, wait for it
  if (offscreenCreationPromise) {
    return offscreenCreationPromise;
  }

  // If already created and verified, return immediately
  if (offscreenCreated) {
    try {
      // Verify it still exists by checking contexts
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
      });

      if (existingContexts.length > 0) {
        return;
      } else {
        // Mark as not created if context is gone
        offscreenCreated = false;
      }
    } catch (error) {
      console.warn('[BG] Failed to check offscreen contexts:', error);
      offscreenCreated = false;
    }
  }

  // Create the offscreen document
  offscreenCreationPromise = createOffscreenDocument();

  try {
    await offscreenCreationPromise;
    offscreenCreated = true;
  } catch (error) {
    console.error('[BG] Failed to create offscreen document:', error);
    offscreenCreated = false;
  } finally {
    offscreenCreationPromise = null;
  }
}

async function createOffscreenDocument() {
  try {
    // Double-check for existing contexts before creating
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length > 0) {
      console.log('[BG] Offscreen document already exists, skipping creation');
      return;
    }

    console.log('[BG] Creating new offscreen document');
    await chrome.offscreen.createDocument({
      // Disable OPFS attempts in offscreen (main thread) to avoid benign warnings
      url: 'offscreen.html?opfs-disable',
      // Use supported reasons. We perform heavy script work and WASM in an offscreen DOM context.
      reasons: ['DOM_SCRAPING', 'IFRAME_SCRIPTING'],
      justification: 'SQLite (WASM) and ML processing in isolated offscreen context'
    });

    console.log('[BG] Offscreen document created successfully');
  } catch (error) {
    if (error.message.includes('Only a single offscreen document may be created')) {
      console.log('[BG] Offscreen document already exists (caught creation error)');
      // This is expected if another process created it first
      return;
    }
    throw error;
  }
}

// Robust message forwarding to offscreen document
async function forwardToOffscreen(message, sendResponse, retryCount = 0) {
  const maxRetries = 2;

  try {
    // Ensure offscreen document exists
    await ensureOffscreenDocument();

    // Small delay to ensure document is fully ready
    if (retryCount === 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Forward the message
    const response = await chrome.runtime.sendMessage(message);
    sendResponse(response);

  } catch (error) {
    const isConnectionError = error.message.includes('Could not establish connection') ||
                              error.message.includes('Receiving end does not exist');

    if (isConnectionError && retryCount < maxRetries) {
      console.warn(`[BG] Connection error (attempt ${retryCount + 1}), retrying in 500ms:`, error.message);

      // Reset offscreen state and retry
      offscreenCreated = false;
      offscreenCreationPromise = null;

      setTimeout(() => {
        forwardToOffscreen(message, sendResponse, retryCount + 1);
      }, 500 * (retryCount + 1)); // Exponential backoff

    } else {
      console.error('[BG] Failed to forward message to offscreen after retries:', error);
      sendResponse({ error: `Offscreen communication failed: ${error.message}` });
    }
  }
}

// Helper function for direct message sending with retries (for background processes)
async function sendToOffscreenWithRetry(message, retryCount = 0) {
  const maxRetries = 2;

  try {
    await ensureOffscreenDocument();

    if (retryCount === 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return await chrome.runtime.sendMessage(message);

  } catch (error) {
    const isConnectionError = error.message.includes('Could not establish connection') ||
                              error.message.includes('Receiving end does not exist');

    if (isConnectionError && retryCount < maxRetries) {
      console.warn(`[BG] Background message retry (attempt ${retryCount + 1}):`, error.message);

      // Reset offscreen state and retry
      offscreenCreated = false;
      offscreenCreationPromise = null;

      await new Promise(resolve => setTimeout(resolve, 500 * (retryCount + 1)));
      return sendToOffscreenWithRetry(message, retryCount + 1);

    } else {
      throw new Error(`Offscreen communication failed after ${maxRetries} retries: ${error.message}`);
    }
  }
}

// Message routing between UI and offscreen
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

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
        const resp = await sendToOffscreenWithRetry({
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
    forwardToOffscreen(message, sendResponse);
    return true; // Keep message channel open for async response
  }

  // Define messages that should be forwarded to offscreen document
  const offscreenMessages = [
    'ingest-page', 'search', 'embed', 'clear-db', 'get-stats',
    'execute-sql', 'clear-model-cache', 'export-db', 'import-db', 'update-summary',
    'refresh-ai-prefs', 'reload-embeddings', 'get-model-status', 'start-remote-warm',
    'get-summary-queue-stats', 'process-summary-queue', 'clear-summary-queue'
  ];

  if (offscreenMessages.includes(message.type)) {
    // Forward to offscreen document with robust error handling
    forwardToOffscreen(message, sendResponse);
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

    case 'onboarding-complete':
      console.log('[BG] Onboarding completed, permissions should be granted');
      sendResponse({ status: 'ok' });
      break;

    case 'get-ingestion-stats':
      sendResponse({
        queueLength: ingestionQueue.length,
        isProcessing: isProcessingQueue,
        currentUrl: ingestionQueue[0]?.url || null,
        recentlyProcessedCount: recentlyProcessed.size,
        pendingTabUpdates: pendingTabUpdates.size,
        performanceMetrics: performanceMetrics
      });
      break;

    default:
      console.warn('[BG] Unknown message type:', message.type);
      sendResponse({ error: 'Unknown message type' });
  }
});

// History ingestion triggers - optimized with duplicate prevention
chrome.history.onVisited.addListener((historyItem) => {
  try {
    // Skip internal URLs and recently processed URLs
    if (isInternalUrl(historyItem.url)) {
      return;
    }

    // Additional filtering to prevent spam from rapid navigation
    if (recentlyProcessed.has(historyItem.url)) {
      console.log(`[BG] Skipping recently processed history item: ${historyItem.url}`);
      return;
    }

    console.log(`[BG] History item queued: ${historyItem.url}`);
    queuePageForIngestion({
      url: historyItem.url,
      title: historyItem.title,
      visitTime: Math.floor(historyItem.lastVisitTime || Date.now())
    });
  } catch (error) {
    console.error('[BG] Error in history listener:', error);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && !isInternalUrl(tab.url)) {
    // Debounce tab updates to prevent rapid-fire processing
    debounceTabUpdate(tabId, {
      url: tab.url,
      title: tab.title,
      visitTime: Math.floor(Date.now()),
      tabId
    });
  }
});

// Auto-capture on navigation completion - optimized to avoid duplicate processing
chrome.webNavigation.onCompleted.addListener(({ tabId, url, frameId }) => {
  try {
    if (frameId !== 0) return; // only top-level frames
    if (!/^https?:\/\//.test(url)) return; // only http/https
    if (isInternalUrl(url)) return; // skip internal URLs

    // Only send auto-capture if we haven't already processed this URL recently
    if (recentlyProcessed.has(url)) {
      console.log(`[BG] Skipping auto-capture for recently processed URL: ${url}`);
      return;
    }

    // Send auto-capture message to content script (non-blocking)
    chrome.tabs.sendMessage(tabId, { type: 'autoCapture' }, () => {
      // Ignore errors when content script isn't present or page is restricted
      void chrome.runtime.lastError;
    });

    console.log(`[BG] Auto-capture triggered for: ${url}`);
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
      sendToOffscreenWithRetry({
        type: 'ingest-captured-payload',
        data: payload
      }).then((resp) => {
        if (resp?.error) {
          console.warn('[BG] Offscreen direct ingest error:', resp.error);
        }
      }).catch((error) => {
        console.warn('[BG] Failed to send captured payload:', error.message);
      });

      // Also send generic ingest signal for any queued items
      sendToOffscreenWithRetry({
        type: 'ingest-captured-queue'
      }).then((resp) => {
        if (resp?.error) {
          console.warn('[BG] Offscreen queue ingest error:', resp.error);
        }
      }).catch((error) => {
        console.warn('[BG] Failed to send queue ingest signal:', error.message);
      });

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
    sendResponse({ success: true, removed });
  } catch (error) {
    console.error('[BG] Failed to delete captured entries:', error);
    sendResponse({ error: error.message });
  }
}

// Page ingestion queue with throttling
const ingestionQueue = [];
let isProcessingQueue = false;
const recentlyProcessed = new Set(); // Track recently processed URLs
const pendingTabUpdates = new Map(); // Debounce tab updates
const DEBOUNCE_DELAY = 500; // 500ms debounce
const PROCESSING_DELAY = 500; // 500ms between processing items
const DUPLICATE_WINDOW = 30000; // 30 seconds duplicate prevention

function isInternalUrl(url) {
  // Skip internal Chrome/Edge pages and extension pages
  return url.startsWith('chrome://') ||
         url.startsWith('chrome-extension://') ||
         url.startsWith('edge://') ||
         url.startsWith('about:') ||
         url.startsWith('file://');
}

function debounceTabUpdate(tabId, pageInfo) {
  // Clear any existing timeout for this tab
  if (pendingTabUpdates.has(tabId)) {
    clearTimeout(pendingTabUpdates.get(tabId).timeoutId);
  }

  // Set up new debounced update
  const timeoutId = setTimeout(() => {
    pendingTabUpdates.delete(tabId);
    queuePageForIngestion(pageInfo);
  }, DEBOUNCE_DELAY);

  pendingTabUpdates.set(tabId, {
    timeoutId,
    pageInfo,
    timestamp: Date.now()
  });

  console.log(`[BG] Debounced tab update for: ${pageInfo.url} (tab ${tabId})`);
}

async function queuePageForIngestion(pageInfo) {
  try {
    // Skip internal URLs that we can't extract content from
    if (isInternalUrl(pageInfo.url)) {
      return;
    }

    // Enhanced duplicate prevention
    const urlKey = pageInfo.url;
    if (recentlyProcessed.has(urlKey)) {
      console.log(`[BG] Skipping recently processed URL: ${pageInfo.url}`);
      return;
    }

    // Check if page already exists in database to avoid unnecessary processing
    try {
      const response = await sendToOffscreenWithRetry({
        type: 'page-exists',
        data: { url: pageInfo.url }
      });
      if (response.exists) {
        console.log(`[BG] Skipping already indexed URL: ${pageInfo.url}`);
        // Still mark as recently processed to avoid repeated checks
        recentlyProcessed.add(urlKey);
        setTimeout(() => recentlyProcessed.delete(urlKey), DUPLICATE_WINDOW);
        return;
      }
    } catch (error) {
      console.warn(`[BG] Failed to check if page exists, proceeding with ingestion:`, error);
    }

    // Mark as recently processed with automatic cleanup
    recentlyProcessed.add(urlKey);
    setTimeout(() => recentlyProcessed.delete(urlKey), DUPLICATE_WINDOW);

    const queueItem = {
      ...pageInfo,
      queuedAt: Date.now(),
      attempts: 0,
      maxAttempts: 2
    };

    ingestionQueue.push(queueItem);
    console.log(`[BG] Queued page for ingestion: ${pageInfo.url} (queue size: ${ingestionQueue.length})`);

    // Broadcast status update to active side panels
    broadcastStatusUpdate('page_queued', {
      url: pageInfo.url,
      title: pageInfo.title,
      queueLength: ingestionQueue.length
    });

    // Start processing queue if not already running
    if (!isProcessingQueue) {
      processIngestionQueue();
    }
  } catch (error) {
    console.error(`[BG] Failed to queue page for ingestion:`, error);
  }
}

async function processIngestionQueue() {
  if (isProcessingQueue || ingestionQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;
  const startTime = Date.now();

  console.log(`[BG] Starting queue processing with ${ingestionQueue.length} items`);

  // Broadcast processing started
  broadcastStatusUpdate('processing_started', {
    queueLength: ingestionQueue.length
  });

  try {
    await ensureOffscreenDocument();

    while (ingestionQueue.length > 0) {
      const pageInfo = ingestionQueue.shift();
      const itemStartTime = Date.now();

      console.log(`[BG] Processing item: ${pageInfo.url} (${ingestionQueue.length} remaining)`);

      try {
        // Extract content with timeout protection
        const tabs = await chrome.tabs.query({ url: pageInfo.url });
        let extractedContent = null;

        if (tabs.length > 0) {
          try {
            // Add timeout to content extraction
            const extractionPromise = sendMessageWithRetry(tabs[0].id, { type: 'getPageContent' });
            extractedContent = await Promise.race([
              extractionPromise,
              new Promise((_, reject) => setTimeout(() => reject(new Error('Content extraction timeout')), 5000))
            ]);
          } catch (e) {
            console.warn(`[BG] Content script extraction failed for ${pageInfo.url}:`, e.message);

            // Fallback to scripting with timeout
            try {
              const scriptingPromise = extractViaScripting(tabs[0]);
              extractedContent = await Promise.race([
                scriptingPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('Scripting timeout')), 5000))
              ]);
            } catch (e2) {
              console.warn(`[BG] Scripting extraction failed for ${pageInfo.url}:`, e2.message);
            }
          }
        }

        // Send to offscreen for processing with retry logic
        const response = await sendToOffscreenWithRetry({
          target: 'offscreen',
          type: 'ingest-page',
          data: {
            ...pageInfo,
            extractedContent
          }
        });

        if (response?.error) {
          console.error(`[BG] Ingestion failed for ${pageInfo.url}:`, response.error);

          // Retry logic for failed items
          pageInfo.attempts = (pageInfo.attempts || 0) + 1;
          if (pageInfo.attempts < pageInfo.maxAttempts) {
            console.log(`[BG] Retrying ${pageInfo.url} (attempt ${pageInfo.attempts + 1}/${pageInfo.maxAttempts})`);
            ingestionQueue.push(pageInfo); // Add back to end of queue
          }
        } else {
          const processingTime = Date.now() - itemStartTime;
          console.log(`[BG] Successfully processed ${pageInfo.url} in ${processingTime}ms`);
          updatePerformanceMetrics(processingTime, true);
        }

      } catch (error) {
        console.error(`[BG] Failed to process page ${pageInfo.url}:`, error);
        updatePerformanceMetrics(0, false);
      }

      // Yield control back to the main thread to prevent UI blocking
      if (ingestionQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, PROCESSING_DELAY));
      }
    }
  } catch (error) {
    console.error('[BG] Queue processing error:', error);
  } finally {
    isProcessingQueue = false;
    const totalTime = Date.now() - startTime;
    console.log(`[BG] Queue processing completed in ${totalTime}ms`);

    // Broadcast processing completed
    broadcastStatusUpdate('processing_completed', {
      totalTime: totalTime,
      queueLength: ingestionQueue.length
    });
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

// Performance monitoring and cleanup
let performanceMetrics = {
  processedPages: 0,
  failedPages: 0,
  totalProcessingTime: 0,
  averageProcessingTime: 0,
  queueHighWaterMark: 0,
  lastReset: Date.now()
};

function updatePerformanceMetrics(processingTime, success = true) {
  if (success) {
    performanceMetrics.processedPages++;
    performanceMetrics.totalProcessingTime += processingTime;
    performanceMetrics.averageProcessingTime =
      performanceMetrics.totalProcessingTime / performanceMetrics.processedPages;
  } else {
    performanceMetrics.failedPages++;
  }

  // Track queue size
  if (ingestionQueue.length > performanceMetrics.queueHighWaterMark) {
    performanceMetrics.queueHighWaterMark = ingestionQueue.length;
  }

  // Log performance stats every 10 processed pages
  if ((performanceMetrics.processedPages + performanceMetrics.failedPages) % 10 === 0) {
    console.log('[BG] Performance metrics:', {
      processed: performanceMetrics.processedPages,
      failed: performanceMetrics.failedPages,
      avgTime: `${performanceMetrics.averageProcessingTime.toFixed(0)}ms`,
      queuePeak: performanceMetrics.queueHighWaterMark,
      currentQueue: ingestionQueue.length
    });
  }
}

// Periodic cleanup of stale data
setInterval(() => {
  try {
    // Clean up stale debounced updates (older than 5 minutes)
    const staleTime = Date.now() - 300000;
    const staleTabIds = [];

    for (const [tabId, data] of pendingTabUpdates.entries()) {
      if (data.timestamp < staleTime) {
        clearTimeout(data.timeoutId);
        staleTabIds.push(tabId);
      }
    }

    staleTabIds.forEach(tabId => pendingTabUpdates.delete(tabId));

    if (staleTabIds.length > 0) {
      console.log(`[BG] Cleaned up ${staleTabIds.length} stale pending tab updates`);
    }

    // Reset performance metrics hourly
    if (Date.now() - performanceMetrics.lastReset > 3600000) {
      console.log('[BG] Hourly performance summary:', performanceMetrics);
      performanceMetrics = {
        processedPages: 0,
        failedPages: 0,
        totalProcessingTime: 0,
        averageProcessingTime: 0,
        queueHighWaterMark: Math.max(0, ingestionQueue.length),
        lastReset: Date.now()
      };
    }
  } catch (error) {
    console.error('[BG] Cleanup error:', error);
  }
}, 60000); // Run every minute

// Status broadcasting to active side panels
async function broadcastStatusUpdate(eventType, data) {
  try {
    const tabs = await chrome.tabs.query({});
    const searchPanelUrl = chrome.runtime.getURL('sidepanel/history_search.html');
    const chatPanelUrl = chrome.runtime.getURL('sidepanel/history_chat.html');

    for (const tab of tabs) {
      if (tab.url === searchPanelUrl || tab.url === chatPanelUrl) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'status_update',
          event: eventType,
          data: data
        }, () => {
          // Ignore errors - panel might not be ready to receive messages
          void chrome.runtime.lastError;
        });
      }
    }
  } catch (error) {
    // Ignore errors in status broadcasting - it's not critical
    console.warn('[BG] Status broadcast failed:', error);
  }
}

// Export performance metrics for debugging
globalThis.getBackgroundMetrics = () => ({
  ...performanceMetrics,
  currentQueue: ingestionQueue.length,
  pendingUpdates: pendingTabUpdates.size,
  recentlyProcessed: recentlyProcessed.size
});
