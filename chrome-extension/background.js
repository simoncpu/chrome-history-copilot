/**
 * AI-Powered Browser History - Background Script (Service Worker)
 * Handles extension lifecycle, side panel setup, context menu, and offscreen orchestration
 */

// Extension installation and startup
chrome.runtime.onInstalled.addListener(() => {
  console.log('[BG] Extension installed');
  setupContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[BG] Extension startup');
});

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
  chrome.contextMenus.create({
    id: 'ai-history-debug',
    title: 'AI History: Debug',
    contexts: ['page', 'action']
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
      url: 'offscreen.html',
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

  // Route messages to offscreen document
  if (message.target === 'offscreen') {
    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage(message).then(sendResponse);
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

    default:
      console.warn('[BG] Unknown message type:', message.type);
      sendResponse({ error: 'Unknown message type' });
  }
});

// History ingestion triggers
chrome.history.onVisited.addListener((historyItem) => {
  console.log('[BG] Page visited:', historyItem.url);
  // Queue for ingestion
  queuePageForIngestion(historyItem);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith('chrome://')) {
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

// Page ingestion queue
const ingestionQueue = [];
let isProcessingQueue = false;

async function queuePageForIngestion(pageInfo) {
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

    while (ingestionQueue.length > 0) {
      const pageInfo = ingestionQueue.shift();

      try {
        // Send to offscreen for processing
        const response = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'ingest-page',
          data: pageInfo
        });

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