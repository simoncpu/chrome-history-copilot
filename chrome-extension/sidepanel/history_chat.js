/**
 * AI History Chat - Chat Page Controller
 */
import { aiBridge } from '../bridge/ai-bridge.js';
import { keywordExtractor } from '../bridge/keyword-extractor.js';
import { logger } from '../utils/logger.js';

// DOM elements
let chatMessages;
let chatInput;
let chatForm;
let sendButton;
let chatLoading;
let chatStatus;
let clearChatButton;
let advancedToggleChat;
let advancedPanelChat;
let toggleRemoteWarmChat;
let modelStatusChat;
let processingStatusChat;
let aiInitStatus;
let aiInitText;

// State
let isGenerating = false;
let chatHistory = [];
let aiSession = null;
let isProcessingPages = false;
let queueStatusInterval = null;
let isLoadingHistory = false;
let isInitialized = false;
const CHAT_THREAD_ID = 'default';

// Feature flags
let shouldDisableInputDuringProcessing = false;  // Default: don't disable inputs during processing

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', initializeChatPage);

function initializeChatPage() {
  if (isInitialized) {
    logger.debug('[CHAT] initializeChatPage: Already initialized, skipping duplicate call');
    return;
  }

  logger.debug('[CHAT] initializeChatPage: Starting initialization');
  isInitialized = true;

  // Get DOM elements
  chatMessages = document.getElementById('chatMessages');
  chatInput = document.getElementById('chatInput');
  chatForm = document.getElementById('chatForm');
  sendButton = document.getElementById('sendButton');
  chatLoading = document.getElementById('chatLoading');
  chatStatus = document.getElementById('chatStatus');
  clearChatButton = document.getElementById('clearChat');
  advancedToggleChat = document.getElementById('advancedToggleChat');
  advancedPanelChat = document.getElementById('advancedPanelChat');
  toggleRemoteWarmChat = document.getElementById('toggleRemoteWarmChat');
  modelStatusChat = document.getElementById('modelStatusChat');
  processingStatusChat = document.getElementById('processingStatusChat');
  aiInitStatus = document.getElementById('aiInitStatus');
  aiInitText = document.getElementById('aiInitText');

  if (!chatMessages || !chatInput) {
    console.error('[CHAT] Required DOM elements not found');
    return;
  }

  // Set up event listeners
  setupEventListeners();

  // Set up tab navigation
  setupTabNavigation();

  // Set up scroll position persistence
  setupScrollPersistence();

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
      } catch (_) { }
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

function setupScrollPersistence() {
  // Scroll position saving (debounced) - matching working pattern from search page
  const chatContainer = document.querySelector('.chat-container');
  let scrollTimeout;
  if (chatContainer) {
    chatContainer.addEventListener('scroll', () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(async () => {
        // Check for actual messages in DOM (excluding welcome message) like the original working logic
        const messageCount = chatMessages ? chatMessages.querySelectorAll('.message:not(#welcomeMessage)').length : 0;
        const currentScrollTop = chatContainer.scrollTop;

        if (messageCount > 0 && currentScrollTop > 0) {
          try {
            await chrome.storage.local.set({ lastChatScrollPosition: currentScrollTop });
          } catch (error) {
            console.error('[CHAT] Failed to save scroll position:', error);
          }
        }
      }, 500); // Use same debounce delay as search page
    });

  } else {
    console.error('[CHAT] .chat-container element not found for scroll persistence');
  }
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

  // Save to PGlite database
  saveChatMessage('user', message);
}

async function generateResponse(userMessage) {
  if (isGenerating) return;

  isGenerating = true;
  updateUI();

  // Show loading screen immediately - don't block browser
  showChatLoading();
  updateChatProgress('Initializing AI system...');

  // Note: Future enhancement to disable chat input during Chrome AI loading is tracked in documentation
  // This would prevent users from submitting more messages while Chrome AI is still loading
  // Implementation: Add a flag to disable the input field and submit button during loading

  // Start Chrome AI loading in background (non-blocking)
  processChatRequest(userMessage).catch(error => {
    console.error('[CHAT] Failed to generate response:', error);
    hideChatLoading();

    // Provide specific error messages based on error type
    let errorMessage = 'AI Error: ';
    if (error.message.includes('not available') || error.message.includes('unavailable')) {
      errorMessage += 'Chrome AI is not available. Please ensure you are using Chrome Canary with AI flags enabled.';
    } else if (error.message.includes('quota') || error.message.includes('limit')) {
      errorMessage += 'AI quota exceeded. Please wait a moment before trying again.';
    } else if (error.message.includes('download')) {
      errorMessage += 'AI model is downloading. Please wait for the download to complete and try again.';
    } else {
      errorMessage += `${error.message}. Please check your Chrome AI configuration.`;
    }

    addErrorMessage(errorMessage);
  }).finally(() => {
    isGenerating = false;
    updateUI();
  });
}

async function processChatRequest(userMessage) {
  try {
    // Step 1: Extract keywords and determine intent using Chrome AI
    console.log('[CHAT] Step 1: Analyzing query intent and extracting keywords:', userMessage);
    updateChatProgress('Waiting for Chrome AI to load...');
    const extractedKeywords = await keywordExtractor.extractKeywords(userMessage, updateChatProgress);
    console.log('[CHAT] Step 1 complete: Intent analysis:', {
      isSearch: extractedKeywords.is_search_query,
      keywords: extractedKeywords
    });

    let searchResults = [];
    let searchQuality = null;

    // Step 2: Search only if user is actually searching for something
    if (extractedKeywords.is_search_query) {
      console.log('[CHAT] Step 2: User is searching - performing history search...');
      updateChatProgress('Searching your browsing history...');
      searchResults = await searchHistoryWithKeywords(extractedKeywords, userMessage);
      searchQuality = analyzeSearchQuality(searchResults);

      console.log('[CHAT] Step 2 complete: Search results analyzed:', {
        resultCount: searchResults?.length || 0,
        quality: searchQuality?.quality,
        firstScore: searchQuality?.firstScore,
        highScoreCount: searchResults?.filter(r => (r.score || r.finalScore || 0) >= 0.6).length || 0
      });

      // Log which results will be used by the AI
      if (searchResults && searchResults.length > 0) {
        console.log('[CHAT] Top search results that will be sent to AI:');
        searchResults.slice(0, 8).forEach((result, index) => {
          const score = result.score || result.finalScore || result.similarity || 0;
          const confidence = score >= 0.6 ? 'HIGH' : score >= 0.3 ? 'MED' : 'LOW';
          console.log(`  AI-${index + 1}. [${confidence}] "${result.title}" (${(score * 100).toFixed(1)}%)`);
        });
      }
    } else {
      console.log('[CHAT] Step 2: User is chatting - skipping search');
      updateChatProgress('Preparing conversational response...');
    }

    // Step 3: Generate AI response with appropriate context
    console.log('[CHAT] Step 3: Generating AI response...');
    updateChatProgress('Generating AI response...');
    const response = await generateAIResponse(
      userMessage,
      extractedKeywords.is_search_query,
      searchResults,
      searchQuality,
      updateChatProgress
    );
    console.log('[CHAT] Step 3 complete: Response generated, length:', response?.length || 0, 'characters');

    // Hide loading and show response
    hideChatLoading();

    // Prepare search metadata if this was a search query
    let searchMetadata = null;
    if (extractedKeywords.is_search_query) {
      searchMetadata = {
        search_metadata: {
          is_search_query: true,
          keywords: extractedKeywords.keywords,
          original_query: userMessage
        }
      };
    }

    addAssistantMessage(response, searchResults, searchMetadata);

  } catch (error) {
    // Re-throw error to be handled by the main generateResponse function
    throw error;
  }
}

async function searchHistoryWithKeywords(extractedKeywords, originalQuery) {
  try {
    // Use extracted keywords as the search query instead of original message
    const keywordsQuery = extractedKeywords.keywords?.join(' ') || originalQuery;

    logger.debug('[CHAT] Original query:', originalQuery);
    logger.debug('[CHAT] Extracted keywords:', extractedKeywords);
    logger.debug('[CHAT] Search query (keywords joined):', keywordsQuery);

    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'search',
      data: {
        query: keywordsQuery,
        // Commented out keyword boosting to match history_search.js behavior
        // keywords: extractedKeywords,
        mode: 'hybrid-rerank',
        limit: 25
      }
    });

    if (response.error) {
      throw new Error(response.error);
    }

    const results = response.results || [];
    console.log('[CHAT] Search results:', results.length, 'pages found');

    // Log detailed search results with scores and order
    if (results.length > 0) {
      console.log('[CHAT] Detailed search results (sorted by relevance):');
      results.forEach((result, index) => {
        const score = result.score || result.finalScore || result.similarity || 0;
        const source = result.source || (result.summary ? 'PGlite' : 'Browser');
        console.log(`  ${index + 1}. [${source}] "${result.title}" (score: ${(score * 100).toFixed(1)}%)`);
        console.log(`     URL: ${result.url}`);
        if (result.summary) {
          console.log(`     Summary: ${result.summary.substring(0, 100)}...`);
        } else if (result.snippet) {
          console.log(`     Snippet: ${result.snippet.substring(0, 100)}...`);
        }
        console.log(''); // Empty line for readability
      });
    }

    return results;
  } catch (error) {
    console.error('[CHAT] History search failed:', error);
    return [];
  }
}



async function generateAIResponse(userMessage, isSearchQuery, searchResults, searchQuality, onProgress = null) {
  await aiBridge.initialize(onProgress);

  if (!aiBridge.isReady()) {
    throw new Error('Chrome AI is not available - ensure Chrome Canary with AI flags enabled');
  }

  console.log('[CHAT] Using Chrome AI for intent-aware response generation');
  return await generateWithChromeAI(userMessage, isSearchQuery, searchResults, searchQuality);
}


async function generateWithChromeAI(userMessage, isSearchQuery, searchResults, searchQuality) {
  try {
    console.log('[CHAT] generateWithChromeAI: Starting intent-aware response generation...');

    // Create session with initialPrompts containing recent chat history
    if (!aiSession) {
      console.log('[CHAT] generateWithChromeAI: Creating new AI session...');
      const recentMessages = getRecentMessagesForSession(); // Get recent messages with intent-aware context
      console.log('[CHAT] generateWithChromeAI: Using', recentMessages.length, 'recent messages for context');

      aiSession = await aiBridge.createLanguageSession({
        initialPrompts: recentMessages
      });
      console.log('[CHAT] generateWithChromeAI: AI session created successfully');
    } else {
      console.log('[CHAT] generateWithChromeAI: Using existing AI session');
    }

    let searchContext = '';

    // Determine what context to provide based on search intent and quality
    if (!isSearchQuery) {
      // User is just chatting, don't append any search context
      console.log('[CHAT] generateWithChromeAI: No search intent - conversational response');
      searchContext = ''; // No search context for casual conversation
    } else {
      // User is searching for something
      if (searchResults.length === 0 || searchQuality.quality === 'none') {
        // No results found
        console.log('[CHAT] generateWithChromeAI: Search intent but no results found');
        searchContext = 'SEARCH_STATUS: No relevant results found in browsing history for this search.';
      } else if (searchQuality.quality === 'low') {
        // Low confidence results
        console.log('[CHAT] generateWithChromeAI: Search intent with low confidence results');
        searchContext = 'SEARCH_STATUS: Found potentially relevant results but confidence is low. Suggest these with uncertainty.\n\n' +
          buildSearchContext(searchResults, searchQuality);
      } else {
        // High confidence results
        console.log('[CHAT] generateWithChromeAI: Search intent with high confidence results');
        searchContext = buildSearchContext(searchResults, searchQuality);
      }
    }

    console.log('[CHAT] generateWithChromeAI: Context prepared, length:', searchContext?.length || 0, 'characters');

    // Use append() to add search context (if any), then generate response
    console.log('[CHAT] generateWithChromeAI: Calling aiBridge.generateResponse...');
    const response = await aiBridge.generateResponse(userMessage, searchContext);
    console.log('[CHAT] generateWithChromeAI: Response received, length:', response?.length || 0, 'characters');

    return response;
  } catch (error) {
    console.error('[CHAT] generateWithChromeAI: Error during response generation:', error);
    throw error;
  }
}


function getRecentMessagesForSession(maxMessages = 24) {
  // Return recent chat history with updated system prompt for intent-aware responses
  const messages = [];

  // Add updated system prompt for intent-aware behavior
  messages.push({
    role: 'system',
    content: `You are an AI assistant that helps users with both casual conversation and finding information from their browsing history.

Your responsibilities:

**For casual conversation:**
- Respond naturally and helpfully without mentioning browsing history
- Be friendly and engaging
- Don't try to search or reference browsing history

**For search queries (when browsing history context is provided):**
- NEVER echo or repeat the raw context data - only reference the information within it
- If SEARCH_STATUS indicates "No relevant results found": Tell the user you couldn't find anything in their browsing history about that topic
- If SEARCH_STATUS indicates "low confidence": Express uncertainty but still provide the results
- For high-confidence results: Present them confidently. Only the first result is high-confidence though. Treat the rest as medium or low confidence.

**Using the enriched context:**
- Reference visit patterns when relevant ("You visited this 3 times" or "You last visited this 2 hours ago")
- Mention the source website when helpful ("According to github.com..." or "From your Stack Overflow browsing...")
- Use recency information to provide context ("This recent article you visited..." vs "This page you looked at last month...")

**Response guidelines:**
- Use **double asterisks** around titles and important terms for emphasis
- Do not include any links or HTML in responses
- Match the user's tone (casual vs. informational)
- Keep responses brief and concise
- Be transparent about search result quality
- Make use of visit history and timing information to provide better context`
  });

  // Add recent chat messages, limiting by maxMessages and rough token count
  const recentHistory = chatHistory.slice(-maxMessages);
  for (const msg of recentHistory) {
    if (messages.length >= maxMessages) break;

    messages.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content
    });
  }

  return messages;
}

/**
 * Analyze the quality of search results based on the first (most relevant) result's score
 * @param {Array} searchResults - Array of search results with score/similarity values
 * @returns {Object} Quality analysis with quality level and first result's score
 */
function analyzeSearchQuality(searchResults) {
  if (!searchResults || searchResults.length === 0) {
    return { quality: 'none', firstScore: 0, count: 0 };
  }

  // Get the first result's score (most relevant)
  const firstResult = searchResults[0];
  const firstScore = firstResult?.score || firstResult?.similarity || firstResult?.finalScore || 0;

  // Calculate all scores for reference
  const scores = searchResults.map(result => {
    return result.score || result.similarity || result.finalScore || 0;
  }).filter(score => typeof score === 'number' && score >= 0);

  if (scores.length === 0) {
    return { quality: 'low', firstScore: 0, count: searchResults.length };
  }

  const maxScore = Math.max(...scores);

  // Determine quality based on the first (most relevant) result's score
  // High quality: first result has good score (>= 0.3)
  // Low quality: first result has poor score (< 0.3)
  let quality;
  if (firstScore >= 0.3) {
    quality = 'high';
  } else {
    quality = 'low';
  }

  console.log('[CHAT] Search quality analysis:', { quality, firstScore, maxScore, count: searchResults.length });

  return {
    quality,
    firstScore,
    maxScore,
    count: searchResults.length,
    scores
  };
}

// Helper function to format timestamps as relative time
function formatLastVisit(timestamp) {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    if (diffMinutes < 60) {
      return `${diffMinutes}m ago`;
    } else if (diffHours < 24) {
      return `${diffHours}h ago`;
    } else if (diffDays < 7) {
      return `${diffDays}d ago`;
    } else if (diffDays < 30) {
      return `${Math.floor(diffDays / 7)}w ago`;
    } else if (diffDays < 365) {
      return `${Math.floor(diffDays / 30)}mo ago`;
    } else {
      return `${Math.floor(diffDays / 365)}y ago`;
    }
  } catch (error) {
    return 'unknown';
  }
}

function buildSearchContext(searchResults, quality = null) {
  console.log('[CHAT] buildSearchContext: Building context for AI with', searchResults?.length || 0, 'results');

  if (searchResults.length === 0) {
    console.log('[CHAT] buildSearchContext: No results - returning empty search message');
    return 'No relevant browsing history found for your search.';
  }

  // Get quality info if not provided
  if (!quality) {
    quality = analyzeSearchQuality(searchResults);
  }

  console.log('[CHAT] buildSearchContext: Quality analysis:', {
    quality: quality.quality,
    firstScore: quality.firstScore?.toFixed(3),
    resultsToInclude: Math.min(searchResults.length, 3)
  });

  let context = '';

  // Add quality context based on confidence level
  if (quality.quality === 'low') {
    context += 'Found some potentially relevant browsing history, but matches have low confidence:\n\n';
  } else {
    context += 'Found relevant browsing history:\n\n';
  }

  const contextResults = searchResults.slice(0, 3);
  console.log('[CHAT] buildSearchContext: Final AI context will include these results (in order):');

  contextResults.forEach((result, index) => {
    const score = result.score || result.similarity || result.finalScore || 0;
    const confidenceLabel = score >= 0.6 ? 'HIGH' : score >= 0.3 ? 'MED' : 'LOW';

    console.log(`  CONTEXT-${index + 1}. [${confidenceLabel}] "${result.title}" (${(score * 100).toFixed(1)}%) - ${result.url}`);

    // Main title with confidence
    context += `## ${result.title}\n`;
    if (quality.quality === 'high' && score >= 0.6) {
      context += `### Confidence\n`;
      context += `High confidence: ${(score * 100).toFixed(0)}%\n`;
    } else if (quality.quality === 'low') {
      context += `### Confidence\n`;
      context += `Low confidence: ${(score * 100).toFixed(0)}%\n`;
    }

    // Website and URL info
    if (result.domain) {
      context += `### Website\n${result.domain}\n`;
    }
    context += `### URL\n${result.url}\n`;

    // Visit information
    const visitInfo = [];
    if (result.visit_count && result.visit_count > 1) {
      visitInfo.push(`${result.visit_count} visits`);
    } else {
      visitInfo.push('1 visit');
    }

    if (result.last_visit_at) {
      visitInfo.push(`last visited ${formatLastVisit(result.last_visit_at)}`);
    }

    if (visitInfo.length > 0) {
      context += `### Visit History\n${visitInfo.join(', ')}\n`;
    }

    // Main content
    if (result.summary || result.snippet) {
      const content = result.summary || result.snippet;
      context += `### Content\n${content}\n`;
    }

    context += `\n---\n\n`;
  });

  console.log('[CHAT] buildSearchContext: Context built, total length:', context.length, 'characters');
  console.log('[CHAT] buildSearchContext: Context preview:', context);

  return context;
}



function addAssistantMessage(content, searchResults = [], searchMetadata = null) {
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
            <div class="message-link-content">
              <span class="message-link-title">${escapeHtml(result.title || 'Untitled')}</span>
              ${result.summary || result.snippet ?
        `<span class="message-link-summary">${escapeHtml((result.summary || result.snippet).substring(0, 120))}...</span>` :
        ''
      }
            </div>
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

  // Save to PGlite database with search metadata if available
  saveChatMessage('assistant', content, searchMetadata);
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
  // Trim leading and trailing whitespace (including newlines)
  content = content.trim();

  // Convert line breaks to HTML
  content = content.replace(/\n/g, '<br>');

  // Convert **bold** to HTML (used for titles per system prompt)
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

function updateChatProgress(message) {
  // Find or create progress text element
  let progressText = document.getElementById('chatProgressText');
  if (!progressText) {
    progressText = document.createElement('div');
    progressText.id = 'chatProgressText';
    progressText.className = 'chat-progress-text';
    progressText.style.cssText = 'font-size: 13px; color: #64748b; margin-top: 8px; text-align: center;';

    // Insert after the typing indicator
    const typingIndicator = chatLoading.querySelector('.typing-indicator');
    if (typingIndicator && typingIndicator.parentNode) {
      typingIndicator.parentNode.insertBefore(progressText, typingIndicator.nextSibling);
    }
  }

  progressText.textContent = message;
  scrollToBottom();
}

function showAIInitLoading(message = 'Initializing AI system...') {
  if (aiInitStatus && aiInitText) {
    aiInitText.textContent = message;
    aiInitStatus.classList.remove('hidden');
  }

  // Disable chat input while initializing
  if (chatInput) {
    chatInput.disabled = true;
    chatInput.placeholder = 'Initializing AI...';
  }
  if (sendButton) {
    sendButton.disabled = true;
  }
}

function hideAIInitLoading() {
  if (aiInitStatus) {
    aiInitStatus.classList.add('hidden');
  }

  // Re-enable chat input
  if (chatInput) {
    chatInput.disabled = false;
    chatInput.placeholder = 'Ask about your browsing history...';
  }
  if (sendButton && !isGenerating) {
    sendButton.disabled = false;
  }
}

function updateUI() {
  if (isGenerating) {
    sendButton.disabled = true;
  } else {
    sendButton.disabled = false;
  }
}

function isNearBottom() {
  const chatContainer = document.querySelector('.chat-container');
  if (!chatContainer) return true;
  const threshold = 100; // pixels from bottom
  return (chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight) <= threshold;
}

function scrollToBottom(retries = 2, force = false) {
  const chatContainer = document.querySelector('.chat-container');
  if (!chatContainer) return;

  // Only auto-scroll if user is near bottom or if forced
  if (!force && !isNearBottom()) {
    return;
  }

  requestAnimationFrame(() => {
    chatContainer.scrollTop = chatContainer.scrollHeight;
    if (retries > 0) {
      setTimeout(() => scrollToBottom(retries - 1, force), 50);
    }
  });
}


// AI initialization
async function initializeAI() {
  // Show loading immediately
  showAIInitLoading('Initializing Chrome AI...');

  try {
    const caps = await aiBridge.initialize();

    // Check availability - Chrome AI is expected to be available
    if (caps?.languageModel?.ready || caps?.languageModel?.available === 'readily' || caps?.languageModel?.available === 'available') {
      console.log('[CHAT] Chrome AI initialized successfully');
      hideAIInitLoading();
    } else if (caps?.languageModel?.available === 'downloadable') {
      console.log('[CHAT] Chrome AI model downloadable, ready to use');
      showAIInitLoading('Downloading AI model...');

      // Hide loader after a delay to show model is ready to use even while downloading
      setTimeout(() => {
        hideAIInitLoading();
      }, 2000);
    } else if (caps?.languageModel?.available === 'downloading') {
      console.log('[CHAT] Chrome AI model downloading');
      showAIInitLoading('Downloading AI model...');

      // Poll for completion
      pollForAIReadiness();
    } else {
      console.log('[CHAT] Chrome AI status:', caps?.languageModel?.available);
      hideAIInitLoading();
    }
  } catch (error) {
    console.error('[CHAT] AI initialization failed:', error);
    hideAIInitLoading();
    throw error; // Fail initialization if Chrome AI is not available
  }
}

// Poll for AI readiness when downloading
async function pollForAIReadiness() {
  const maxAttempts = 60; // Poll for up to 2 minutes
  let attempts = 0;

  const checkReadiness = async () => {
    attempts++;
    try {
      const caps = await aiBridge.initialize();

      if (caps?.languageModel?.ready || caps?.languageModel?.available === 'available' || caps?.languageModel?.available === 'readily') {
        // AI is ready
        console.log('[CHAT] Chrome AI download completed');
        hideAIInitLoading();
        return;
      }

      if (attempts < maxAttempts && caps?.languageModel?.available === 'downloading') {
        // Still downloading, check again in 2 seconds
        setTimeout(checkReadiness, 2000);
      } else {
        // Either completed with different status or timeout
        console.log('[CHAT] AI polling stopped:', caps?.languageModel?.available);
        hideAIInitLoading();
      }
    } catch (error) {
      console.error('[CHAT] Error polling AI readiness:', error);
      if (attempts < maxAttempts) {
        setTimeout(checkReadiness, 2000);
      } else {
        hideAIInitLoading();
      }
    }
  };

  setTimeout(checkReadiness, 2000); // Start polling after initial delay
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
    logger.debug('[CHAT] Failed to load aiPrefs');
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
  if (isLoadingHistory) {
    console.log('[CHAT] loadChatHistory: Already loading, skipping duplicate call');
    return;
  }

  try {
    isLoadingHistory = true;
    console.log('[CHAT] loadChatHistory: Starting to load chat history');

    // Clear existing messages (except welcome message) before loading history
    const existingMessages = chatMessages.querySelectorAll('.message:not(#welcomeMessage)');
    console.log('[CHAT] loadChatHistory: Clearing', existingMessages.length, 'existing messages before loading history');
    existingMessages.forEach(message => message.remove());

    // Deduplicate any existing duplicates in the database
    try {
      const dedupeResponse = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'deduplicate-chat-messages',
        data: { threadId: CHAT_THREAD_ID }
      });
      if (dedupeResponse.removedCount > 0) {
        console.log('[CHAT] loadChatHistory: Removed', dedupeResponse.removedCount, 'duplicate messages from database');
      }
    } catch (error) {
      console.warn('[CHAT] loadChatHistory: Failed to deduplicate messages:', error);
    }

    // Load chat messages from PGlite database
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'get-chat-messages',
      data: { threadId: CHAT_THREAD_ID, limit: 20 }
    });

    if (response.error) {
      console.error('[CHAT] Failed to load chat messages:', response.error);
      return;
    }

    const messages = response.messages || [];
    chatHistory = messages;
    console.log('[CHAT] loadChatHistory: Loading', messages.length, 'messages from database');

    // Restore messages in UI
    let messagesWithSearchRerun = 0;
    for (const [index, message] of messages.entries()) {
      console.log('[CHAT] loadChatHistory: Adding message', index + 1, 'of', messages.length, '- Role:', message.role, 'metadata:', !!message.metadata);
      if (message.role === 'user') {
        addUserMessageFromHistory(message.content);
      } else if (message.role === 'assistant') {
        // Check if this message will trigger a search rerun
        if (message.metadata?.search_metadata?.is_search_query) {
          messagesWithSearchRerun++;
        }
        await addAssistantMessageFromHistory(message.content, message.metadata);
      }
    }

    console.log('[CHAT] Messages with search rerun:', messagesWithSearchRerun);

    // Update storage preference
    await chrome.storage.local.set({ lastSidePanelPage: 'chat' });

    // Restore scroll position after all messages are processed - matching search page pattern
    // Use different timing based on whether there were search reruns (like auto-load vs new search in search page)
    const scrollDelay = messagesWithSearchRerun > 0 ? 1500 : 300;

    setTimeout(async () => {
      try {
        const stored = await chrome.storage.local.get(['lastChatScrollPosition']);
        const chatContainer = document.querySelector('.chat-container');

        if (chatContainer && stored.lastChatScrollPosition && stored.lastChatScrollPosition > 0) {
          chatContainer.scrollTop = stored.lastChatScrollPosition;
        }
      } catch (error) {
        console.error('[CHAT] Failed to restore scroll position:', error);
      }
    }, scrollDelay);
  } catch (error) {
    console.error('[CHAT] Failed to load chat history:', error);
  } finally {
    isLoadingHistory = false;
    console.log('[CHAT] loadChatHistory: Finished loading chat history');
  }
}

async function saveChatMessage(role, content, metadata = null) {
  try {
    console.log('[CHAT] saveChatMessage: Called with role:', role, 'content length:', content.length, 'metadata:', !!metadata);

    // Save message to PGlite database
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'save-chat-message',
      data: { threadId: CHAT_THREAD_ID, role, content, metadata }
    });

    if (response.error) {
      console.error('[CHAT] Failed to save chat message:', response.error);
      return;
    }

    // Update local history
    chatHistory.push({
      id: response.messageId,
      role,
      content,
      metadata,
      timestamp: Date.now()
    });

    console.log('[CHAT] Message saved successfully:', response.messageId, 'Total local history:', chatHistory.length);
  } catch (error) {
    console.error('[CHAT] Failed to save chat message:', error);
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

  // Append after the welcome message (messages load in chronological order)
  chatMessages.appendChild(messageDiv);
}

async function addAssistantMessageFromHistory(content, metadata = null) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant-message';

  // Process content to make links clickable
  const processedContent = processMessageContent(content);

  let linksHtml = '';
  let searchResults = [];

  // If this message has search metadata, re-run the search to get fresh results
  if (metadata?.search_metadata?.is_search_query) {
    try {
      console.log('[CHAT] Re-running search for historical message with keywords:', metadata.search_metadata.keywords);

      // Re-create the extractedKeywords object to match the format expected by searchHistoryWithKeywords
      const extractedKeywords = {
        is_search_query: true,
        keywords: metadata.search_metadata.keywords || []
      };

      searchResults = await searchHistoryWithKeywords(extractedKeywords, metadata.search_metadata.original_query);
      console.log('[CHAT] Re-run search found', searchResults.length, 'results for historical message');

      // Generate links HTML if we have results
      if (searchResults.length > 0) {
        linksHtml = `
          <div class="message-links">
            ${searchResults.slice(0, 5).map(result => `
              <a href="${result.url}" class="message-link" target="_blank" rel="noopener noreferrer">
                <img src="${result.favicon_url || getFaviconUrl(result.url, result.domain)}" class="message-link-favicon" alt="" onerror="this.style.display='none'">
                <div class="message-link-content">
                  <span class="message-link-title">${escapeHtml(result.title || 'Untitled')}</span>
                  ${result.summary || result.snippet ?
            `<span class="message-link-summary">${escapeHtml((result.summary || result.snippet).substring(0, 120))}...</span>` :
            ''
          }
                </div>
              </a>
            `).join('')}
          </div>
        `;
      }
    } catch (error) {
      console.error('[CHAT] Failed to re-run search for historical message:', error);
      // Continue with empty search results if re-run fails
    }
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

  // Append after the welcome message (messages load in chronological order)
  chatMessages.appendChild(messageDiv);
}

async function handleClearChat() {
  try {
    // Clear chat thread in PGlite database
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'clear-chat-thread',
      data: { threadId: CHAT_THREAD_ID }
    });

    if (response.error) {
      console.error('[CHAT] Failed to clear chat thread:', response.error);
    }

    // Clear local state
    chatHistory = [];

    // Remove all messages except the welcome message
    const children = Array.from(chatMessages.children);
    children.forEach((node) => {
      if (!(node.id === 'welcomeMessage')) {
        chatMessages.removeChild(node);
      }
    });

    // Clear stored scroll position (matching search page pattern)
    try {
      await chrome.storage.local.set({ lastChatScrollPosition: 0 });
    } catch (error) {
      console.error('[CHAT] Failed to clear scroll position:', error);
    }

    // Reset AI session to start fresh
    if (aiSession) {
      try {
        await aiBridge.cleanup();
        aiSession = null;
      } catch (error) {
        console.warn('[CHAT] Failed to cleanup AI session:', error);
      }
    }

    // Reset UI state
    isGenerating = false;
    updateUI();
    scrollToBottom(2, true);
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
}

function enableChatInput() {
  if (chatInput && !isGenerating) {
    chatInput.disabled = false;
    chatInput.placeholder = 'Ask about your browsing history...';
  }
  if (sendButton && !isGenerating) {
    sendButton.disabled = false;
  }
}


// Real-time status update listener
function setupStatusUpdateListener() {
  chrome.runtime.onMessage.addListener((message) => {
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
  isProcessingPages,
  // Export production functions for debug.js testing
  processChatRequest,
  searchHistoryWithKeywords,
  buildSearchContext,
  generateAIResponse,
  analyzeSearchQuality
};
