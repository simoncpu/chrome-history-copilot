/**
 * AI History Chat - Chat Page Controller
 */
import { aiBridge } from '../bridge/ai-bridge.js';

console.log('[CHAT] Initializing chat page');

// DOM elements
let chatMessages;
let chatInput;
let chatForm;
let sendButton;
let chatLoading;
let chatStatus;
let statusText;

// State
let isGenerating = false;
let chatHistory = [];
let aiSession = null;

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', initializeChatPage);

function initializeChatPage() {
  console.log('[CHAT] DOM loaded, initializing...');

  // Get DOM elements
  chatMessages = document.getElementById('chatMessages');
  chatInput = document.getElementById('chatInput');
  chatForm = document.getElementById('chatForm');
  sendButton = document.getElementById('sendButton');
  chatLoading = document.getElementById('chatLoading');
  chatStatus = document.getElementById('chatStatus');
  statusText = document.getElementById('statusText');

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

  // Load chat history
  loadChatHistory();

  console.log('[CHAT] Chat page initialized');
}

function setupEventListeners() {
  // Chat form submission
  chatForm.addEventListener('submit', handleChatSubmit);

  // Auto-resize textarea
  chatInput.addEventListener('input', handleInputResize);

  // Prevent default on enter if shift is not pressed
  chatInput.addEventListener('keydown', handleInputKeydown);
}

function setupTabNavigation() {
  const tabButtons = document.querySelectorAll('.tab-button');

  tabButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      const targetPage = e.target.dataset.page;
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

  console.log('[CHAT] Submitting message:', message);

  // Clear input and reset height
  chatInput.value = '';
  handleInputResize();

  // Add user message to chat
  addUserMessage(message);

  // Start generating response
  await generateResponse(message);
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
  console.log('[CHAT] Searching history for:', query);

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
  console.log('[CHAT] Generating AI response for:', userMessage);

  // Try to use Chrome AI API
  try {
    const caps = await aiBridge.initialize();
    if (await aiBridge.isLanguageModelAvailable()) {
      return await generateWithChromeAI(userMessage, searchResults);
    }
  } catch (error) {
    console.warn('[CHAT] Chrome AI not available:', error);
  }

  // Fallback to structured response
  return generateStructuredResponse(userMessage, searchResults);
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

function generateStructuredResponse(userMessage, searchResults) {
  if (searchResults.length === 0) {
    return `I couldn't find any relevant pages in your browsing history for "${userMessage}". Try searching with different keywords or check if you've visited pages related to this topic.`;
  }

  let response = `Here's what I found in your browsing history related to "${userMessage}":\n\n`;

  searchResults.slice(0, 5).forEach((result, index) => {
    response += `${index + 1}. **${result.title}**\n`;
    response += `   ${result.url}\n`;
    if (result.summary || result.snippet) {
      response += `   ${(result.summary || result.snippet).substring(0, 100)}...\n`;
    }
    response += '\n';
  });

  if (searchResults.length > 5) {
    response += `... and ${searchResults.length - 5} more results.`;
  }

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
            <img src="${result.favicon_url || `chrome://favicon/${result.url}`}" class="message-link-favicon" alt="" onerror="this.style.display='none'">
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

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// AI initialization
async function initializeAI() {
  try {
    const caps = await aiBridge.initialize();
    console.log('[CHAT] AI capabilities:', caps);
    if (caps?.languageModel?.available === 'readily') {
      statusText.textContent = 'AI ready';
    } else if (caps?.languageModel) {
      statusText.textContent = 'AI initializing...';
    } else {
      statusText.textContent = 'AI not available - using fallback';
    }
  } catch (error) {
    console.warn('[CHAT] AI initialization failed:', error);
    statusText.textContent = 'Using structured responses';
  }
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
  const welcomeMessage = chatMessages.querySelector('.assistant-message');
  if (welcomeMessage) {
    chatMessages.insertBefore(messageDiv, welcomeMessage);
  } else {
    chatMessages.appendChild(messageDiv);
  }
}

// Utility functions
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Export for debugging
window.chatPageController = {
  generateResponse,
  chatHistory,
  aiSession
};
