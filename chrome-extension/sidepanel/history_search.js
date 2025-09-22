/**
 * AI History Search - Search Page Controller
 */

console.log('[SEARCH] Initializing search page');

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

// State
let currentQuery = '';
let currentResults = [];
let currentOffset = 0;
let isLoading = false;
let hasMoreResults = false;

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', initializeSearchPage);

function initializeSearchPage() {
  console.log('[SEARCH] DOM loaded, initializing...');

  // Get DOM elements
  searchInput = document.getElementById('searchInput');
  searchButton = document.getElementById('searchButton');
  advancedToggle = document.getElementById('advancedToggle');
  advancedPanel = document.getElementById('advancedPanel');
  searchMode = document.getElementById('searchMode');
  loadingState = document.getElementById('loadingState');
  emptyState = document.getElementById('emptyState');
  errorState = document.getElementById('errorState');
  resultsList = document.getElementById('resultsList');
  loadMoreButton = document.getElementById('loadMoreButton');

  if (!searchInput) {
    console.error('[SEARCH] Required DOM elements not found');
    return;
  }

  // Set up event listeners
  setupEventListeners();

  // Load saved preferences
  loadUserPreferences();

  // Set up tab navigation
  setupTabNavigation();

  console.log('[SEARCH] Search page initialized');
}

function setupEventListeners() {
  // Search input handlers
  searchInput.addEventListener('input', handleSearchInput);
  searchInput.addEventListener('keydown', handleSearchKeydown);

  // Search button
  searchButton.addEventListener('click', handleSearchSubmit);

  // Advanced options toggle
  advancedToggle.addEventListener('click', toggleAdvancedPanel);

  // Search mode change
  searchMode.addEventListener('change', handleSearchModeChange);

  // Load more button
  loadMoreButton.addEventListener('click', handleLoadMore);
}

function setupTabNavigation() {
  const tabButtons = document.querySelectorAll('.tab-button');

  tabButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      const targetPage = e.target.dataset.page;
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

function toggleAdvancedPanel() {
  const isHidden = advancedPanel.classList.contains('hidden');

  if (isHidden) {
    advancedPanel.classList.remove('hidden');
    advancedToggle.classList.add('expanded');
  } else {
    advancedPanel.classList.add('hidden');
    advancedToggle.classList.remove('expanded');
  }
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
async function performSearch(query, offset = 0) {
  console.log('[SEARCH] Performing search:', query, 'offset:', offset);

  if (isLoading) return;

  currentQuery = query;
  isLoading = true;

  // Show loading state
  if (offset === 0) {
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
        mode: searchMode.value,
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
    } else {
      currentResults = [...currentResults, ...results];
    }

    currentOffset += results.length;
    hasMoreResults = results.length === 25; // Assume more if we got a full page

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
  if (currentOffset - currentResults.length + (currentResults.length - 25) <= 0) {
    resultsList.innerHTML = '';
  }

  // Add new results
  const newResults = currentResults.slice(-25); // Last 25 results (the new ones)
  newResults.forEach(result => {
    const resultElement = createResultElement(result);
    resultsList.appendChild(resultElement);
  });

  // Show/hide load more button
  if (hasMoreResults) {
    loadMoreButton.classList.remove('hidden');
  } else {
    loadMoreButton.classList.add('hidden');
  }
}

function createResultElement(result) {
  const article = document.createElement('article');
  article.className = 'result-item';

  // Create clickable link
  const link = document.createElement('a');
  link.href = result.url;
  link.className = 'result-item';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';

  // Favicon
  const favicon = document.createElement('img');
  favicon.className = 'result-favicon';
  favicon.src = result.favicon_url || `chrome://favicon/${result.url}`;
  favicon.alt = '';
  favicon.onerror = () => {
    favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
  };

  // Content container
  const content = document.createElement('div');
  content.className = 'result-content';

  // Title
  const title = document.createElement('h3');
  title.className = 'result-title';
  title.textContent = result.title || 'Untitled';

  // URL
  const url = document.createElement('div');
  url.className = 'result-url';
  url.textContent = result.url;

  // Snippet
  const snippet = document.createElement('p');
  snippet.className = 'result-snippet';
  snippet.textContent = result.summary || result.snippet || 'No description available';

  // Assemble elements
  content.appendChild(title);
  content.appendChild(url);
  content.appendChild(snippet);

  link.appendChild(favicon);
  link.appendChild(content);

  article.appendChild(link);

  return article;
}

// User preferences
async function loadUserPreferences() {
  try {
    const result = await chrome.storage.local.get(['searchMode', 'lastSidePanelPage']);

    if (result.searchMode) {
      searchMode.value = result.searchMode;
    }

  } catch (error) {
    console.error('[SEARCH] Failed to load preferences:', error);
  }
}

async function saveUserPreferences() {
  try {
    await chrome.storage.local.set({
      searchMode: searchMode.value,
      lastSidePanelPage: 'search'
    });
  } catch (error) {
    console.error('[SEARCH] Failed to save preferences:', error);
  }
}

// Export for debugging
window.searchPageController = {
  performSearch,
  currentResults,
  currentQuery
};