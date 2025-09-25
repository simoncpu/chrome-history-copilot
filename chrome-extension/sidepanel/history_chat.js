/**
 * AI History Chat - Chat Page Controller
 */
import { aiBridge } from '../bridge/ai-bridge.js';

// DOM elements
let chatMessages;
let chatInput;
let chatForm;
let sendButton;
let chatLoading;
let chatStatus;
let statusText;
let clearChatButton;
let advancedToggleChat;
let advancedPanelChat;
let toggleRemoteWarmChat;
let modelStatusChat;
let processingStatusChat;

// State
let isGenerating = false;
let chatHistory = [];
let aiSession = null;
let isProcessingPages = false;
let queueStatusInterval = null;

// Feature flags
let shouldDisableInputDuringProcessing = false;  // Default: don't disable inputs during processing

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', initializeChatPage);

function initializeChatPage() {

  // Get DOM elements
  chatMessages = document.getElementById('chatMessages');
  chatInput = document.getElementById('chatInput');
  chatForm = document.getElementById('chatForm');
  sendButton = document.getElementById('sendButton');
  chatLoading = document.getElementById('chatLoading');
  chatStatus = document.getElementById('chatStatus');
  statusText = document.getElementById('statusText');
  clearChatButton = document.getElementById('clearChat');
  advancedToggleChat = document.getElementById('advancedToggleChat');
  advancedPanelChat = document.getElementById('advancedPanelChat');
  toggleRemoteWarmChat = document.getElementById('toggleRemoteWarmChat');
  modelStatusChat = document.getElementById('modelStatusChat');
  processingStatusChat = document.getElementById('processingStatusChat');

  if (!chatMessages || !chatInput) {
    console.error('[CHAT] Required DOM elements not found');
    return;
  }

  // Set up event listeners
  setupEventListeners();

  // Set up tab navigation
  setupTabNavigation();

  // Initialize AI session
  initializeAI();

  // Load remote-warm prefs and status
  loadChatPrefs();
  updateModelStatusChat();
  startModelWarmWatcherChat();

  // Load chat history
  loadChatHistory();

  // Host-permissions onboarding
  setupPermissionsOnboarding();

  // Start monitoring summarization queue
  startQueueMonitoring();

  // Set up real-time status update listener
  setupStatusUpdateListener();

}

// Note: Site access is optional; UI initializes regardless. The debug page
// and background fallback will request optional host permissions if needed.

async function setupPermissionsOnboarding() {
  const overlay = document.getElementById('permissionOverlay');
  const grantAllBtn = document.getElementById('grantAllSites');
  const openSettingsBtn = document.getElementById('openExtSettings');

  if (!overlay) return;

  const checkAllSitesGranted = async () => {
    try {
      // Treat either https or http all-sites as sufficient to hide the overlay
      const hasHttps = await chrome.permissions.contains({ origins: ['https://*/*'] });
      if (hasHttps) return true;
      const hasHttp = await chrome.permissions.contains({ origins: ['http://*/*'] });
      return !!hasHttp;
    } catch (_) {
      return true; // fail-closed (don’t block UI)
    }
  };

  const maybeShowOverlay = async () => {
    const has = await checkAllSitesGranted();
    if (!has) overlay.classList.remove('hidden');
    else overlay.classList.add('hidden');
  };

  if (grantAllBtn) {
    grantAllBtn.addEventListener('click', async () => {
      try {
        let granted = await chrome.permissions.request({ origins: ['https://*/*'] });
        if (!granted) {
          granted = await chrome.permissions.request({ origins: ['http://*/*'] });
        }
        if (granted) overlay.classList.add('hidden');
      } catch (_) {}
    });
  }

  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
    });
  }

  await maybeShowOverlay();
}

function setupEventListeners() {
  // Chat form submission
  chatForm.addEventListener('submit', handleChatSubmit);

  // Auto-resize textarea
  chatInput.addEventListener('input', handleInputResize);

  // Prevent default on enter if shift is not pressed
  chatInput.addEventListener('keydown', handleInputKeydown);

  // Clear chat history
  if (clearChatButton) {
    clearChatButton.addEventListener('click', handleClearChat);
  }

  // Advanced settings dropdown
  if (advancedToggleChat) {
    advancedToggleChat.addEventListener('click', toggleChatSettingsDropdown);
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!advancedToggleChat.contains(e.target) && !advancedPanelChat.contains(e.target)) {
      closeChatSettingsDropdown();
    }
  });

  // Close settings with Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !advancedPanelChat.classList.contains('hidden')) {
      closeChatSettingsDropdown();
    }
  });

  // Remote warm toggle
  if (toggleRemoteWarmChat) {
    toggleRemoteWarmChat.addEventListener('change', async (e) => {
      try {
        await saveAiPrefs({ enableRemoteWarm: !!e.target.checked });
        if (e.target.checked && modelStatusChat) {
          modelStatusChat.innerHTML = '<span class="inline-spinner"></span>Model: warming larger remote model… (using local)';
        }
        await chrome.runtime.sendMessage({ type: 'refresh-ai-prefs' });
        if (e.target.checked) {
          await chrome.runtime.sendMessage({ type: 'start-remote-warm' });
        }
        await updateModelStatusChat();
        if (e.target.checked) startModelWarmWatcherChat();
      } catch (err) {
        console.warn('[CHAT] Failed to update remote warm pref:', err);
      }
    });
  }
}

function setupTabNavigation() {
  const tabButtons = document.querySelectorAll('.tab');

  tabButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      const targetPage = e.currentTarget.dataset.page;
      if (targetPage === 'search') {
        // Navigate to search page
        window.location.href = 'history_search.html';
      }
    });
  });
}

// Auto-resize textarea
function handleInputResize() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
}

function handleInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleChatSubmit(e);
  }
}

// Chat submission
async function handleChatSubmit(e) {
  e.preventDefault();

  const message = chatInput.value.trim();
  if (!message || isGenerating) return;

  

  // Clear input and reset height
  chatInput.value = '';
  handleInputResize();

  // Add user message to chat
  addUserMessage(message);

  // Start generating response
  await generateResponse(message);
  // Ensure view stays at latest after response
  scrollToBottom();
}

function addUserMessage(message) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message user-message';

  messageDiv.innerHTML = `
    <div class="message-avatar">👤</div>
    <div class="message-content">
      <div class="message-text">${escapeHtml(message)}</div>
    </div>
  `;

  chatMessages.appendChild(messageDiv);
  scrollToBottom();

  // Add to history
  chatHistory.push({ role: 'user', content: message, timestamp: Date.now() });
  saveChatHistory();
}

async function generateResponse(userMessage) {
  if (isGenerating) return;

  isGenerating = true;
  updateUI();

  try {
    // Show loading indicator
    showChatLoading();

    // First, search for relevant history items
    const searchResults = await searchHistory(userMessage);

    // Generate AI response
    const response = await generateAIResponse(userMessage, searchResults);

    // Hide loading and show response
    hideChatLoading();
    addAssistantMessage(response, searchResults);

  } catch (error) {
    console.error('[CHAT] Failed to generate response:', error);
    hideChatLoading();
    addErrorMessage('Sorry, I encountered an error while processing your request. Please try again.');
  } finally {
    isGenerating = false;
    updateUI();
  }
}

async function searchHistory(query) {
  

  try {
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'search',
      data: {
        query: query,
        mode: 'hybrid-rerank',
        limit: 10
      }
    });

    if (response.error) {
      throw new Error(response.error);
    }

    return response.results || [];
  } catch (error) {
    console.error('[CHAT] History search failed:', error);
    return [];
  }
}

async function generateAIResponse(userMessage, searchResults) {
  // Strict: require Chrome AI to be available
  await aiBridge.initialize();
  return await generateWithChromeAI(userMessage, searchResults);
}

async function generateWithChromeAI(userMessage, searchResults) {
  // Ensure language session
  if (!aiSession) {
    aiSession = await aiBridge.createLanguageSession();
  }

  // Build context: search results + recent chat turns
  const resultsContext = aiBridge.buildContext(searchResults, 8);
  const turnsContext = buildChatTurnsContext(10, 2000);
  const combinedContext = [resultsContext, turnsContext].filter(Boolean).join('\n\n');

  // Generate response via bridge
  const response = await aiBridge.generateResponse(userMessage, combinedContext);
  return response;
}

function buildContext(searchResults) {
  if (searchResults.length === 0) {
    return 'No relevant browsing history found.';
  }

  let context = 'Relevant browsing history:\n\n';

  searchResults.slice(0, 8).forEach((result, index) => {
    context += `${index + 1}. ${result.title}\n`;
    context += `   URL: ${result.url}\n`;
    if (result.summary || result.snippet) {
      context += `   Content: ${(result.summary || result.snippet).substring(0, 200)}...\n`;
    }
    context += '\n';
  });

  return context;
}

function buildChatTurnsContext(maxTurns = 10, maxChars = 2000) {
  if (!Array.isArray(chatHistory) || chatHistory.length === 0) return '';
  const recent = chatHistory.slice(-maxTurns);
  let buf = 'Recent chat context (most recent last):\n\n';
  for (const msg of recent) {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    const text = String(msg.content || '').replace(/\s+/g, ' ').trim();
    const line = `${role}: ${text}\n`;
    if ((buf.length + line.length) > maxChars) break;
    buf += line;
  }
  return buf;
}

function addAssistantMessage(content, searchResults = []) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant-message';

  // Process content to make links clickable
  const processedContent = processMessageContent(content);

  let linksHtml = '';
  if (searchResults.length > 0) {
    linksHtml = `
      <div class="message-links">
        ${searchResults.slice(0, 5).map(result => `
          <a href="${result.url}" class="message-link" target="_blank" rel="noopener noreferrer">
            <img src="${result.favicon_url || getFaviconUrl(result.url, result.domain)}" class="message-link-favicon" alt="" onerror="this.style.display='none'">
            <span class="message-link-title">${escapeHtml(result.title || 'Untitled')}</span>
          </a>
        `).join('')}
      </div>
    `;
  }

  messageDiv.innerHTML = `
    <div class="message-avatar">🤖</div>
    <div class="message-content">
      <div class="message-text">
        ${processedContent}
        ${linksHtml}
      </div>
    </div>
  `;

  chatMessages.appendChild(messageDiv);
  scrollToBottom();

  // Add to history
  chatHistory.push({
    role: 'assistant',
    content: content,
    searchResults: searchResults.slice(0, 5),
    timestamp: Date.now()
  });
  saveChatHistory();
}

function addErrorMessage(message) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant-message';

  messageDiv.innerHTML = `
    <div class="message-avatar">⚠️</div>
    <div class="message-content">
      <div class="message-text">${escapeHtml(message)}</div>
    </div>
  `;

  chatMessages.appendChild(messageDiv);
  scrollToBottom();
}

function processMessageContent(content) {
  // Convert markdown-style links to HTML links
  content = content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // Convert URLs to clickable links
  content = content.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

  // Convert line breaks to HTML
  content = content.replace(/\n/g, '<br>');

  // Convert **bold** to HTML
  content = content.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  return content;
}

// UI management
function showChatLoading() {
  chatLoading.classList.remove('hidden');
  scrollToBottom();
}

function hideChatLoading() {
  chatLoading.classList.add('hidden');
}

function updateUI() {
  if (isGenerating) {
    sendButton.disabled = true;
    statusText.textContent = 'Generating response...';
  } else {
    sendButton.disabled = false;
    statusText.textContent = 'Ready to chat';
  }
}

function scrollToBottom(retries = 2) {
  if (!chatMessages) return;
  requestAnimationFrame(() => {
    chatMessages.scrollTop = chatMessages.scrollHeight;
    if (retries > 0) {
      setTimeout(() => scrollToBottom(retries - 1), 50);
    }
  });
}

// AI initialization
async function initializeAI() {
  try {
    const caps = await aiBridge.initialize();
    
    if (caps?.languageModel?.available === 'readily') {
      statusText.textContent = 'AI ready';
    } else if (caps?.languageModel) {
      statusText.textContent = 'AI initializing...';
    } else {
      statusText.textContent = 'AI not available';
    }
  } catch (error) {
    console.warn('[CHAT] AI initialization failed:', error);
    statusText.textContent = 'AI not available';
  }
}

async function loadChatPrefs() {
  try {
    const result = await chrome.storage.local.get(['aiPrefs']);
    if (toggleRemoteWarmChat) {
      const pref = !!(result.aiPrefs && result.aiPrefs.enableRemoteWarm);
      toggleRemoteWarmChat.checked = pref;
    }

    // Load input disabling preference (default: false - don't disable)
    shouldDisableInputDuringProcessing = !!(result.aiPrefs?.disableInputDuringProcessing);
  } catch (e) {
    console.debug('[CHAT] Failed to load aiPrefs');
  }
}

async function saveAiPrefs(partial) {
  const store = await chrome.storage.local.get(['aiPrefs']);
  const next = Object.assign({}, store.aiPrefs || {}, partial);
  await chrome.storage.local.set({ aiPrefs: next });
}

async function updateModelStatusChat() {
  if (!modelStatusChat) return;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get-model-status' });
    const ms = resp && resp.modelStatus ? resp.modelStatus : null;
    if (!ms) { modelStatusChat.textContent = 'Model status: unavailable'; return; }
    if (ms.warming) {
      modelStatusChat.innerHTML = '<span class="inline-spinner"></span>Model: warming larger remote model… (using local)';
    } else if (ms.using === 'remote') {
      modelStatusChat.textContent = 'Model: Remote (large)';
    } else {
      modelStatusChat.textContent = 'Model: Local (quantized)';
    }
    if (ms.lastError) {
      modelStatusChat.textContent += ` — warm-up failed: ${ms.lastError}`;
    }
  } catch (e) {
    modelStatusChat.textContent = 'Model status: error retrieving';
  }
}

let modelWarmWatcherChat = null;
function startModelWarmWatcherChat(timeoutMs = 120000) {
  if (!modelStatusChat) return;
  if (modelWarmWatcherChat) return;
  const started = Date.now();
  modelWarmWatcherChat = setInterval(async () => {
    await updateModelStatusChat();
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'get-model-status' });
      const ms = resp && resp.modelStatus ? resp.modelStatus : null;
      if (!ms || !ms.warming || ms.using === 'remote') {
        clearInterval(modelWarmWatcherChat);
        modelWarmWatcherChat = null;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(modelWarmWatcherChat);
        modelWarmWatcherChat = null;
      }
    } catch {
      clearInterval(modelWarmWatcherChat);
      modelWarmWatcherChat = null;
    }
  }, 2000);
}

// Chat history persistence
async function loadChatHistory() {
  try {
    const result = await chrome.storage.local.get(['chatHistory']);
    if (result.chatHistory && Array.isArray(result.chatHistory)) {
      chatHistory = result.chatHistory;

      // Restore recent messages (last 10)
      const recentHistory = chatHistory.slice(-10);
      recentHistory.forEach(message => {
        if (message.role === 'user') {
          addUserMessageFromHistory(message.content);
        } else if (message.role === 'assistant') {
          addAssistantMessage(message.content, message.searchResults || []);
        }
      });

      // Update storage preference
      await chrome.storage.local.set({ lastSidePanelPage: 'chat' });
    }

    // Ensure we start scrolled to bottom when opening chat
    scrollToBottom();
  } catch (error) {
    console.error('[CHAT] Failed to load chat history:', error);
  }
}

async function saveChatHistory() {
  try {
    // Keep only recent history (last 50 messages) to avoid storage bloat
    const recentHistory = chatHistory.slice(-50);
    await chrome.storage.local.set({ chatHistory: recentHistory });
  } catch (error) {
    console.error('[CHAT] Failed to save chat history:', error);
  }
}

function addUserMessageFromHistory(content) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message user-message';

  messageDiv.innerHTML = `
    <div class="message-avatar">👤</div>
    <div class="message-content">
      <div class="message-text">${escapeHtml(content)}</div>
    </div>
  `;

  // Insert before the welcome message
  const welcomeMessage = chatMessages.querySelector('#welcomeMessage');
  if (welcomeMessage) {
    chatMessages.insertBefore(messageDiv, welcomeMessage);
  } else {
    chatMessages.appendChild(messageDiv);
  }
}

async function handleClearChat() {
  try {
    // Clear state and storage
    chatHistory = [];
    await chrome.storage.local.set({ chatHistory: [] });

    // Remove all messages except the welcome message
    const children = Array.from(chatMessages.children);
    children.forEach((node) => {
      if (!(node.id === 'welcomeMessage')) {
        chatMessages.removeChild(node);
      }
    });

    // Reset UI state
    isGenerating = false;
    updateUI();
    scrollToBottom();
  } catch (e) {
    console.error('[CHAT] Failed to clear chat:', e);
  }
}

// Utility functions
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getFaviconUrl(url, domain) {
  try {
    const host = domain || new URL(url).hostname;
    return `https://www.google.com/s2/favicons?sz=16&domain=${encodeURIComponent(host)}`;
  } catch (_) {
    return 'https://www.google.com/s2/favicons?sz=16&domain=example.com';
  }
}

// Settings dropdown functions
function toggleChatSettingsDropdown() {
  const isHidden = advancedPanelChat.classList.contains('hidden');

  if (isHidden) {
    openChatSettingsDropdown();
  } else {
    closeChatSettingsDropdown();
  }
}

function openChatSettingsDropdown() {
  advancedPanelChat.classList.remove('hidden');
  advancedToggleChat.classList.add('active');
}

function closeChatSettingsDropdown() {
  advancedPanelChat.classList.add('hidden');
  advancedToggleChat.classList.remove('active');
}

// Queue monitoring functions (similar to search page)
async function startQueueMonitoring() {
  // Initial check
  await checkQueueStatus();

  // Set up periodic checking
  queueStatusInterval = setInterval(checkQueueStatus, 2000); // Check every 2 seconds
}

async function checkQueueStatus() {
  try {
    // Get both ingestion and summarization queue stats
    const [summaryResponse, ingestionResponse] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'get-summary-queue-stats' }),
      chrome.runtime.sendMessage({ type: 'get-ingestion-stats' })
    ]);

    if (summaryResponse?.stats || ingestionResponse) {
      const summaryStats = summaryResponse?.stats || {};
      const ingestionStats = ingestionResponse || {};

      // Only show progress for ingestion work, not summarization
      const hasIngestionWork = ingestionStats.isProcessing || (ingestionStats.queueLength > 0);
      isProcessingPages = hasIngestionWork; // Only ingestion work triggers progress indicator

      if (isProcessingPages) {
        showProcessingStatusChat();
        if (shouldDisableInputDuringProcessing) {
          disableChatInput();
        }
      } else {
        hideProcessingStatusChat();
        if (shouldDisableInputDuringProcessing) {
          enableChatInput();
        }
      }
    }
  } catch (error) {
    console.error('[CHAT] Failed to check queue status:', error);
  }
}

function showProcessingStatusChat() {
  if (!processingStatusChat) return;
  processingStatusChat.classList.remove('hidden');
}

function hideProcessingStatusChat() {
  if (!processingStatusChat) return;
  processingStatusChat.classList.add('hidden');
}

function disableChatInput() {
  if (chatInput && !isGenerating) {
    chatInput.disabled = true;
    chatInput.placeholder = 'Processing pages... Chat will be available when complete.';
  }
  if (sendButton && !isGenerating) {
    sendButton.disabled = true;
  }
  if (statusText) {
    statusText.textContent = 'Processing pages...';
  }
}

function enableChatInput() {
  if (chatInput && !isGenerating) {
    chatInput.disabled = false;
    chatInput.placeholder = 'Ask about your browsing history...';
  }
  if (sendButton && !isGenerating) {
    sendButton.disabled = false;
  }
  if (statusText && !isGenerating) {
    statusText.textContent = 'Ready to chat';
  }
}

// Additional escape function to avoid conflicts
function escapeHtmlChat(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Real-time status update listener
function setupStatusUpdateListener() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'status_update') {
      handleStatusUpdate(message.event, message.data);
    }

    // Handle content indexing notifications
    if (message.type === 'content_indexed') {
      handleContentIndexed(message.data);
    }
  });
}

// Handle new content being indexed
function handleContentIndexed(data) {
  console.log('[CHAT] New content indexed:', data.url);

  // Hide progress indicator when indexing is complete
  if (data.indexingComplete && isProcessingPages) {
    console.log('[CHAT] Indexing complete, hiding progress indicator');
    isProcessingPages = false;
    hideProcessingStatusChat();
    if (shouldDisableInputDuringProcessing) {
      enableChatInput();
    }
  }
}

function handleStatusUpdate(eventType, data) {
  console.log(`[CHAT] Status update: ${eventType}`, data);

  switch (eventType) {
    case 'navigation_started':
      // Show progress immediately when navigation begins
      if (!isProcessingPages) {
        isProcessingPages = true;
        showProcessingStatusChat();
        if (shouldDisableInputDuringProcessing) {
          disableChatInput();
        }
      }
      break;

    case 'page_queued':
      // Continue showing processing status when a page is queued
      if (!isProcessingPages) {
        isProcessingPages = true;
        showProcessingStatusChat();
        if (shouldDisableInputDuringProcessing) {
          disableChatInput();
        }
      }
      break;

    case 'processing_started':
      // Update status to show processing has begun
      isProcessingPages = true;
      // Trigger immediate queue status check to get latest data
      setTimeout(() => checkQueueStatus(), 100);
      break;

    case 'processing_completed':
      // Processing completed, will be picked up by normal queue monitoring
      // Trigger immediate queue status check
      setTimeout(() => checkQueueStatus(), 100);
      break;
  }
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (queueStatusInterval) {
    clearInterval(queueStatusInterval);
  }
});

// Export for debugging
window.chatPageController = {
  generateResponse,
  chatHistory,
  aiSession,
  checkQueueStatus,
  isProcessingPages
};
