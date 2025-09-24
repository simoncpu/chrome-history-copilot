/**
 * AI History Search - Search Page Controller
 */



// DOM elements
let searchInput;
let searchButton;
let advancedToggle;
let advancedPanel;
let searchMode;
let loadingState;
let emptyState;
let errorState;
let resultsList;
let loadMoreButton;
let toggleRemoteWarm;
let modelStatusEl;
let processingStatus;
let processingDetails;

// State
let currentQuery = '';
let currentResults = [];
let currentOffset = 0;
let isLoading = false;
let hasMoreResults = false;
let lastBatch = [];
let isAutoLoading = false;

// Feature flags
let shouldDisableInputDuringProcessing = false;  // Default: don't disable inputs during processing
let isProcessingPages = false;
let queueStatusInterval = null;

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', initializeSearchPage);

function initializeSearchPage() {

  // Get DOM elements
  searchInput = document.getElementById('searchInput');
  searchButton = document.getElementById('searchButton');
  advancedToggle = document.getElementById('advancedToggle');
  advancedPanel = document.getElementById('advancedPanel');
  // searchMode now handled via radio buttons
  searchMode = null; // Will be handled by helper functions
  loadingState = document.getElementById('loadingState');
  emptyState = document.getElementById('emptyState');
  errorState = document.getElementById('errorState');
  resultsList = document.getElementById('resultsList');
  loadMoreButton = document.getElementById('loadMoreButton');
  toggleRemoteWarm = document.getElementById('toggleRemoteWarm');
  modelStatusEl = document.getElementById('modelStatus');
  processingStatus = document.getElementById('processingStatus');
  processingDetails = document.getElementById('processingDetails');

  if (!searchInput) {
    console.error('[SEARCH] Required DOM elements not found');
    return;
  }

  // Set up event listeners
  setupEventListeners();

  // Load saved preferences and auto-execute last search
  loadAndExecuteLastSearch();

  // Query model status on load
  updateModelStatus();
  startModelWarmWatcher();

  // Set up tab navigation
  setupTabNavigation();

  // Host-permissions onboarding
  setupPermissionsOnboarding();

  // Start monitoring summarization queue
  startQueueMonitoring();

}

// Load preferences and execute last search if available
async function loadAndExecuteLastSearch() {
  try {
    const lastQuery = await loadUserPreferences();

    if (lastQuery && lastQuery.trim().length >= 2) {
      // Set the search input to the saved query
      searchInput.value = lastQuery;

      // Auto-execute the search
      performSearch(lastQuery, 0, true);
    }
  } catch (error) {
    console.error('[SEARCH] Failed to load and execute last search:', error);
  }
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
        // Request https first (most common); if declined, try http as fallback
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
  // Search input handlers
  searchInput.addEventListener('input', handleSearchInput);
  searchInput.addEventListener('keydown', handleSearchKeydown);

  // Search button
  searchButton.addEventListener('click', handleSearchSubmit);

  // Advanced options toggle
  advancedToggle.addEventListener('click', toggleSettingsDropdown);

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!advancedToggle.contains(e.target) && !advancedPanel.contains(e.target)) {
      closeSettingsDropdown();
    }
  });

  // Close settings with Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !advancedPanel.classList.contains('hidden')) {
      closeSettingsDropdown();
    }
  });

  // Remote warm toggle
  if (toggleRemoteWarm) {
    toggleRemoteWarm.addEventListener('change', async (e) => {
      try {
        await saveAiPrefs({ enableRemoteWarm: !!e.target.checked });
        // Show warming spinner immediately for snappy UX
        if (e.target.checked && modelStatusEl) {
          modelStatusEl.innerHTML = '<span class="inline-spinner"></span>Model: warming larger remote model… (using local)';
        }
        await chrome.runtime.sendMessage({ type: 'refresh-ai-prefs' });
        if (e.target.checked) {
          // Also explicitly request warm-up
          await chrome.runtime.sendMessage({ type: 'start-remote-warm' });
        }
        await updateModelStatus();
        if (e.target.checked) startModelWarmWatcher();
      } catch (err) {
        console.warn('[SEARCH] Failed to update remote warm pref:', err);
      }
    });
  }

  // Search mode radio buttons
  const radioButtons = document.querySelectorAll('input[name="searchMode"]');
  radioButtons.forEach(radio => {
    radio.addEventListener('change', handleSearchModeChange);
  });

  // Load more button
  loadMoreButton.addEventListener('click', handleLoadMore);

  // Scroll position saving (debounced)
  const scrollWrapper = document.querySelector('.content-scroll-wrapper');
  let scrollTimeout;
  if (scrollWrapper) {
    scrollWrapper.addEventListener('scroll', () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(async () => {
        // Only save if there are search results displayed
        if (currentResults.length > 0) {
          try {
            await chrome.storage.local.set({ lastScrollPosition: scrollWrapper.scrollTop });
          } catch (error) {
            console.error('[SEARCH] Failed to save scroll position:', error);
          }
        }
      }, 500); // Debounce delay
    });
  }
}

function setupTabNavigation() {
  const tabButtons = document.querySelectorAll('.tab');

  tabButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      const targetPage = e.currentTarget.dataset.page;
      if (targetPage === 'chat') {
        // Navigate to chat page
        window.location.href = 'history_chat.html';
      }
    });
  });
}

// Search input handling with debounce
let searchTimeout;
function handleSearchInput(e) {
  const query = e.target.value.trim();

  // Clear previous timeout
  clearTimeout(searchTimeout);

  // Debounce search (300ms delay)
  searchTimeout = setTimeout(() => {
    if (query.length >= 2) {
      performSearch(query);
    } else if (query.length === 0) {
      showEmptyState();
    }
  }, 300);
}

function handleSearchKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleSearchSubmit();
  }
}

function handleSearchSubmit() {
  const query = searchInput.value.trim();
  if (query.length >= 2) {
    performSearch(query);
  }
}

function toggleSettingsDropdown() {
  const isHidden = advancedPanel.classList.contains('hidden');

  if (isHidden) {
    openSettingsDropdown();
  } else {
    closeSettingsDropdown();
  }
}

function openSettingsDropdown() {
  advancedPanel.classList.remove('hidden');
  advancedToggle.classList.add('active');
}

function closeSettingsDropdown() {
  advancedPanel.classList.add('hidden');
  advancedToggle.classList.remove('active');
}

function handleSearchModeChange() {
  // Save preference
  saveUserPreferences();

  // Re-run search if there's an active query
  if (currentQuery) {
    performSearch(currentQuery);
  }
}

function handleLoadMore() {
  if (hasMoreResults && !isLoading) {
    performSearch(currentQuery, currentOffset);
  }
}

// Search execution
async function performSearch(query, offset = 0, isAutoLoad = false) {

  if (isLoading) return;

  // Clear scroll position if this is a new search query (but not on auto-load)
  if (offset === 0 && query !== currentQuery && currentQuery !== '') {
    try {
      await chrome.storage.local.set({ lastScrollPosition: 0 });
    } catch (error) {
      console.error('[SEARCH] Failed to clear scroll position:', error);
    }
  }

  currentQuery = query;
  isLoading = true;
  isAutoLoading = isAutoLoad;

  // Show loading state
  if (offset === 0) {

    // Save the search query for next session
    try {
      await chrome.storage.local.set({ lastSearchQuery: query });
    } catch (error) {
      console.error('[SEARCH] Failed to save last search query:', error);
    }

    showLoadingState();
    currentResults = [];
    currentOffset = 0;
  } else {
    loadMoreButton.textContent = 'Loading...';
    loadMoreButton.disabled = true;
  }

  try {
    // Send search request to offscreen document
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'search',
      data: {
        query: query,
        mode: getSelectedSearchMode(),
        limit: 25,
        offset: offset
      }
    });

    if (response.error) {
      throw new Error(response.error);
    }

    const results = response.results || [];

    if (offset === 0) {
      currentResults = results;
      lastBatch = results;
    } else {
      // Dedupe on append by id or URL
      const seen = new Set(currentResults.map(r => r.id || r.url));
      const filtered = results.filter(r => !seen.has(r.id || r.url));
      currentResults = [...currentResults, ...filtered];
      lastBatch = filtered;
    }

    currentOffset = currentResults.length;
    hasMoreResults = (results.length === 25); // backend page full

    // Display results
    if (currentResults.length === 0 && offset === 0) {
      showEmptyState(true); // Show "no results" variant
    } else {
      displayResults();
    }

  } catch (error) {
    console.error('[SEARCH] Search failed:', error);
    showErrorState(error.message);
  } finally {
    isLoading = false;
    loadMoreButton.textContent = 'Load More Results';
    loadMoreButton.disabled = false;
  }
}

// UI state management
function showLoadingState() {
  hideAllStates();
  loadingState.classList.remove('hidden');
}

function showEmptyState(noResults = false) {
  hideAllStates();
  emptyState.classList.remove('hidden');

  if (noResults) {
    emptyState.querySelector('h3').textContent = 'No Results Found';
    emptyState.querySelector('p').textContent = 'Try different keywords or check your search mode settings.';
  } else {
    emptyState.querySelector('h3').textContent = 'Search Your History';
    emptyState.querySelector('p').textContent = 'Enter a query above to search through your browsing history using AI-powered semantic search.';
  }
}

function showErrorState(message) {
  hideAllStates();
  errorState.classList.remove('hidden');
  document.getElementById('errorMessage').textContent = message;
}

function hideAllStates() {
  loadingState.classList.add('hidden');
  emptyState.classList.add('hidden');
  errorState.classList.add('hidden');
  resultsList.classList.add('hidden');
  loadMoreButton.classList.add('hidden');
}

function displayResults() {
  hideAllStates();
  resultsList.classList.remove('hidden');

  // Clear existing results if this is a new search
  if (currentOffset === (lastBatch?.length || 0)) {
    resultsList.innerHTML = '';
  }

  // Add new results
  const newResults = lastBatch && lastBatch.length ? lastBatch : currentResults;
  newResults.forEach((result, index) => {
    const resultElement = createResultElement(result);

    if (!isAutoLoading) {
      // Add staggered animation delay for new searches
      resultElement.style.animationDelay = `${index * 100}ms`;
    } else {
      // Skip animation for auto-load to enable instant scroll
      resultElement.style.animation = 'none';
    }

    resultsList.appendChild(resultElement);
  });

  // Show/hide load more button
  if (hasMoreResults) {
    loadMoreButton.classList.remove('hidden');
  } else {
    loadMoreButton.classList.add('hidden');
  }

  // Restore scroll position after animations complete (only on initial load, not pagination)
  if (currentOffset === (lastBatch?.length || 0)) {
    // Use different timing based on whether this is auto-load or new search
    const scrollDelay = isAutoLoading ? 50 : 1200; // Instant vs animated

    setTimeout(async () => {
      try {
        const stored = await chrome.storage.local.get(['lastScrollPosition']);

        if (stored.lastScrollPosition && stored.lastScrollPosition > 0) {
          const scrollWrapper = document.querySelector('.content-scroll-wrapper');

          if (scrollWrapper) {
            scrollWrapper.scrollTop = stored.lastScrollPosition;
          }
        }
      } catch (error) {
        console.error('[SEARCH] Failed to restore scroll position:', error);
      }

      // Reset auto-loading flag after scroll restoration is complete
      isAutoLoading = false;
    }, scrollDelay);
  }
}

function createResultElement(result) {
  const article = document.createElement('article');
  article.className = 'result-item';

  // Create clickable link
  const link = document.createElement('a');
  link.href = result.url;
  link.className = 'result-link';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';

  // Header row container (favicon + header as siblings)
  const headerRow = document.createElement('div');
  headerRow.className = 'result-header-row';

  // Favicon
  const favicon = document.createElement('img');
  favicon.className = 'result-favicon';
  favicon.src = result.favicon_url || getFaviconUrl(result.url, result.domain);
  favicon.alt = '';
  favicon.onerror = () => {
    favicon.style.background = 'linear-gradient(135deg, #7dd3fc, #a78bfa)';
    favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
  };

  // Header with just title
  const header = document.createElement('div');
  header.className = 'result-header';

  // Title
  const title = document.createElement('h3');
  title.className = 'result-title';
  title.textContent = result.title || 'Untitled';

  header.appendChild(title);

  // Add favicon and header to header row
  headerRow.appendChild(favicon);
  headerRow.appendChild(header);

  // Details container (url, snippet, metadata without left margin)
  const details = document.createElement('div');
  details.className = 'result-details';

  // URL
  const url = document.createElement('div');
  url.className = 'result-url';
  url.textContent = result.url;

  // Snippet
  const snippet = document.createElement('p');
  snippet.className = 'result-snippet';
  snippet.textContent = result.summary || result.snippet || 'No description available';

  // Metadata container
  const metadata = document.createElement('div');
  metadata.className = 'result-metadata';

  // Search mode badge (moved from header)
  const modeBadge = createSearchModeBadge(getSelectedSearchMode());
  metadata.appendChild(modeBadge);

  // Visit count pill (if available)
  if (result.visit_count && result.visit_count > 1) {
    const visitPill = document.createElement('span');
    visitPill.className = 'visit-count-pill';
    visitPill.innerHTML = `👁️ ${result.visit_count} visits`;
    metadata.appendChild(visitPill);
  }

  // Last visit time (if available)
  if (result.last_visit_at) {
    const lastVisit = document.createElement('span');
    lastVisit.className = 'last-visit';
    lastVisit.innerHTML = `🕒 ${formatLastVisit(result.last_visit_at)}`;
    metadata.appendChild(lastVisit);
  }

  // Relevance indicator (if score available)
  if (result.score !== undefined) {
    const relevanceIndicator = document.createElement('div');
    relevanceIndicator.className = 'relevance-indicator';

    const relevanceLabel = document.createElement('span');
    relevanceLabel.textContent = 'Relevance:';

    const relevanceBar = document.createElement('div');
    relevanceBar.className = 'relevance-bar';

    const relevanceFill = document.createElement('div');
    relevanceFill.className = 'relevance-fill';
    // Normalize score to 0-100% (assuming score is 0-1)
    const scorePercent = Math.max(0, Math.min(100, (result.score || 0) * 100));
    relevanceFill.style.width = `${scorePercent}%`;

    relevanceBar.appendChild(relevanceFill);
    relevanceIndicator.appendChild(relevanceLabel);
    relevanceIndicator.appendChild(relevanceBar);
    metadata.appendChild(relevanceIndicator);
  }

  // Assemble details elements
  details.appendChild(url);
  details.appendChild(snippet);
  if (metadata.children.length > 0) {
    details.appendChild(metadata);
  }

  // Assemble the link
  link.appendChild(headerRow);
  link.appendChild(details);

  article.appendChild(link);

  return article;
}

function createSearchModeBadge(mode) {
  const badge = document.createElement('span');
  badge.className = 'search-mode-badge';

  let badgeText = '';
  let badgeClass = '';

  switch (mode) {
    case 'hybrid-rerank':
      badgeText = '🚀 Hybrid+';
      badgeClass = 'search-mode-rerank';
      break;
    case 'hybrid-rrf':
      badgeText = '⚡ Hybrid (RRF)';
      badgeClass = 'search-mode-hybrid';
      break;
    case 'text':
      badgeText = '📝 Text';
      badgeClass = 'search-mode-text';
      break;
    case 'vector':
      badgeText = '🧠 Vector';
      badgeClass = 'search-mode-vector';
      break;
    default:
      badgeText = '🔍 Default';
      badgeClass = 'search-mode-hybrid';
  }

  badge.textContent = badgeText;
  badge.classList.add(badgeClass);

  return badge;
}

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
    } else {
      return date.toLocaleDateString();
    }
  } catch (e) {
    return 'recently';
  }
}

function getFaviconUrl(url, domain) {
  try {
    const host = domain || new URL(url).hostname;
    return `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(host)}`;
  } catch (_) {
    return 'https://www.google.com/s2/favicons?sz=32&domain=example.com';
  }
}

// User preferences
async function loadUserPreferences() {
  try {
    const result = await chrome.storage.local.get(['searchMode', 'lastSidePanelPage', 'aiPrefs', 'lastSearchQuery']);

    if (result.searchMode) {
      setSelectedSearchMode(result.searchMode);
    }

    if (toggleRemoteWarm) {
      const pref = !!(result.aiPrefs && result.aiPrefs.enableRemoteWarm);
      toggleRemoteWarm.checked = pref;
    }

    // Load input disabling preference (default: false - don't disable)
    shouldDisableInputDuringProcessing = !!(result.aiPrefs?.disableInputDuringProcessing);

    // Return the last search query for auto-execution
    return result.lastSearchQuery || null;

  } catch (error) {
    console.error('[SEARCH] Failed to load preferences:', error);
    return null;
  }
}

async function saveUserPreferences() {
  try {
    await chrome.storage.local.set({
      searchMode: getSelectedSearchMode(),
      lastSidePanelPage: 'search'
    });
  } catch (error) {
    console.error('[SEARCH] Failed to save preferences:', error);
  }
}

async function saveAiPrefs(partial) {
  const store = await chrome.storage.local.get(['aiPrefs']);
  const next = Object.assign({}, store.aiPrefs || {}, partial);
  await chrome.storage.local.set({ aiPrefs: next });
}

async function updateModelStatus() {
  if (!modelStatusEl) return;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get-model-status' });
    const ms = resp && resp.modelStatus ? resp.modelStatus : null;
    if (!ms) {
      modelStatusEl.textContent = 'Model status: unavailable';
      return;
    }
    if (ms.warming) {
      modelStatusEl.innerHTML = '<span class="inline-spinner"></span>Model: warming larger remote model… (using local)';
    } else if (ms.using === 'remote') {
      modelStatusEl.textContent = 'Model: Remote (large)';
    } else {
      modelStatusEl.textContent = 'Model: Local (quantized)';
    }
    if (ms.lastError) {
      modelStatusEl.textContent += ` — warm-up failed: ${ms.lastError}`;
    }
  } catch (e) {
    modelStatusEl.textContent = 'Model status: error retrieving';
  }
}

let modelWarmWatcher = null;
function startModelWarmWatcher(timeoutMs = 120000) {
  if (!modelStatusEl) return;
  if (modelWarmWatcher) return;
  const started = Date.now();
  modelWarmWatcher = setInterval(async () => {
    await updateModelStatus();
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'get-model-status' });
      const ms = resp && resp.modelStatus ? resp.modelStatus : null;
      if (!ms || !ms.warming || ms.using === 'remote') {
        clearInterval(modelWarmWatcher);
        modelWarmWatcher = null;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(modelWarmWatcher);
        modelWarmWatcher = null;
      }
    } catch {
      clearInterval(modelWarmWatcher);
      modelWarmWatcher = null;
    }
  }, 2000);
}

// Helper functions for radio button search mode
function getSelectedSearchMode() {
  const checked = document.querySelector('input[name="searchMode"]:checked');
  return checked ? checked.value : 'hybrid-rerank';
}

function setSelectedSearchMode(mode) {
  const radio = document.querySelector(`input[name="searchMode"][value="${mode}"]`);
  if (radio) {
    radio.checked = true;
  }
}

// Queue monitoring functions
async function startQueueMonitoring() {
  // Initial check
  await checkQueueStatus();

  // Set up periodic checking
  queueStatusInterval = setInterval(checkQueueStatus, 5000); // Check every 5 seconds
}

async function checkQueueStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-summary-queue-stats' });

    if (response && response.stats) {
      const stats = response.stats;
      const wasProcessing = isProcessingPages;

      isProcessingPages = stats.isProcessing || (stats.queueLength > 0);

      if (isProcessingPages) {
        showProcessingStatus(stats);
        if (shouldDisableInputDuringProcessing) {
          disableSearchInput();
        }
      } else {
        hideProcessingStatus();
        if (shouldDisableInputDuringProcessing) {
          enableSearchInput();
        }
      }

      // If processing just finished, refresh the search to show updated summaries
      if (wasProcessing && !isProcessingPages && currentQuery) {
        console.log('[SEARCH] Processing finished, refreshing search results');
        // Small delay to ensure database is updated
        setTimeout(() => {
          performSearch(currentQuery, 0, true);
        }, 1000);
      }
    }
  } catch (error) {
    console.error('[SEARCH] Failed to check queue status:', error);
  }
}

function showProcessingStatus(stats) {
  if (!processingStatus || !processingDetails) return;

  const queuedCount = stats.queueLength || 0;
  const completedCount = stats.completed || 0;
  const failedCount = stats.failed || 0;

  let details = `Queued: ${queuedCount}`;
  if (completedCount > 0) details += `, Completed: ${completedCount}`;
  if (failedCount > 0) details += `, Failed: ${failedCount}`;

  // Show currently processing item if available
  if (stats.currentlyProcessing) {
    const proc = stats.currentlyProcessing;
    processingDetails.innerHTML = `
      <div>Processing: <strong>${escapeHtml(proc.title)}</strong></div>
      <div>${details}</div>
    `;
  } else {
    processingDetails.textContent = details;
  }

  processingStatus.classList.remove('hidden');
}

function hideProcessingStatus() {
  if (!processingStatus) return;
  processingStatus.classList.add('hidden');
}

function disableSearchInput() {
  if (searchInput) {
    searchInput.disabled = true;
    searchInput.placeholder = 'Processing pages... Search will be available when complete.';
  }
  if (searchButton) {
    searchButton.disabled = true;
  }
}

function enableSearchInput() {
  if (searchInput) {
    searchInput.disabled = false;
    searchInput.placeholder = 'Search your browsing history...';
  }
  if (searchButton) {
    searchButton.disabled = false;
  }
}

// Utility function to escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (queueStatusInterval) {
    clearInterval(queueStatusInterval);
  }
});

// Export for debugging
window.searchPageController = {
  performSearch,
  currentResults,
  currentQuery,
  checkQueueStatus,
  isProcessingPages
};
