/**
 * AI History Debug - Debug Page Controller
 */


// DOM elements
let pageCount, embeddingCount, statusIndicator, statusText;
let writeMode, sqlQuery, queryResults, resultsContent;
let refreshStats, executeQuery, clearQuery, sampleQueries;
let clearModelCache, clearDatabase;
let operationProgress, progressFill;
let logContainer, clearLogs, exportLogs, autoRefreshLogs;
// Permissions elements
let grantAllSitesAccessBtn, grantCurrentSiteAccessBtn, checkCurrentSiteAccessBtn, openExtensionSettingsBtn;
// Queue elements
let queueLength, queueCompleted, queueFailed, queueStatusIndicator, queueStatusText;
let currentlyProcessing, processingDetails;
let refreshQueueStats, processQueue, clearQueue;

// Content analysis elements
let analyzeRecentPages, showContentStats, testSearchModes;
let contentAnalysis, analysisContent;

// State
let isConnected = false;
let currentLogs = [];
let logRefreshInterval = null;

// Sample queries for convenience - Chrome Extension specific
const SAMPLE_QUERIES = [
  // Basic inspection
  'SELECT * FROM pages LIMIT 5;',
  'SELECT name, sql FROM sqlite_master WHERE type=\'table\';',
  'PRAGMA table_info(pages);',

  // Extension functionality checks
  'SELECT vec_version();',
  'SELECT COUNT(*) as total_pages FROM pages;',
  'SELECT COUNT(*) as pages_with_embeddings FROM pages WHERE embedding IS NOT NULL;',

  // Recent browsing history
  'SELECT title, url, domain, last_visit_at, visit_count FROM pages ORDER BY last_visit_at DESC LIMIT 10;',
  'SELECT domain, COUNT(*) as page_count FROM pages GROUP BY domain ORDER BY page_count DESC LIMIT 10;',

  // Search functionality testing
  'SELECT title, url FROM pages_fts WHERE pages_fts MATCH \'AI\' LIMIT 5;',
  'SELECT id, title, url FROM pages WHERE embedding IS NOT NULL LIMIT 5;',

  // Extension debugging
  'SELECT COUNT(*) as fts_entries FROM pages_fts;',
  'SELECT url, title, length(content_text) as content_length FROM pages WHERE content_text IS NOT NULL LIMIT 5;',

  // Content extraction analysis
  'SELECT url, title, length(content_text) as content_len, summary IS NOT NULL as has_summary FROM pages WHERE content_text IS NOT NULL ORDER BY last_visit_at DESC LIMIT 10;',
  'SELECT domain, COUNT(*) as pages, AVG(length(content_text)) as avg_content_len FROM pages WHERE content_text IS NOT NULL GROUP BY domain ORDER BY pages DESC LIMIT 10;',
  'SELECT COUNT(*) as with_content, (SELECT COUNT(*) FROM pages) as total FROM pages WHERE content_text IS NOT NULL AND length(content_text) > 100;',

  // Performance analysis
  'SELECT domain, AVG(visit_count) as avg_visits, COUNT(*) as pages FROM pages GROUP BY domain HAVING COUNT(*) > 1 ORDER BY avg_visits DESC LIMIT 10;',
  'SELECT title, url, visit_count FROM pages ORDER BY visit_count DESC LIMIT 10;'
];

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', initializeDebugPage);

function initializeDebugPage() {
  // Get DOM elements
  initializeDOMElements();

  if (!pageCount || !sqlQuery) {
    console.error('[DEBUG] Required DOM elements not found');
    return;
  }

  // Set up event listeners
  setupEventListeners();

  // Connect to offscreen document
  connectToOffscreen();

  // Start auto-refresh for logs
  startLogRefresh();

  // Load preferences
  loadPreferences();
}

function initializeDOMElements() {
  // Status elements
  pageCount = document.getElementById('pageCount');
  embeddingCount = document.getElementById('embeddingCount');
  statusIndicator = document.getElementById('statusIndicator');
  statusText = document.getElementById('statusText');

  // Query elements
  writeMode = document.getElementById('writeMode');
  sqlQuery = document.getElementById('sqlQuery');
  queryResults = document.getElementById('queryResults');
  resultsContent = document.getElementById('resultsContent');

  // Button elements
  refreshStats = document.getElementById('refreshStats');
  executeQuery = document.getElementById('executeQuery');
  clearQuery = document.getElementById('clearQuery');
  sampleQueries = document.getElementById('sampleQueries');
  clearModelCache = document.getElementById('clearModelCache');
  clearDatabase = document.getElementById('clearDatabase');

  // Progress elements
  operationProgress = document.getElementById('operationProgress');
  progressFill = document.getElementById('progressFill');

  // Log elements
  logContainer = document.getElementById('logContainer');
  clearLogs = document.getElementById('clearLogs');
  exportLogs = document.getElementById('exportLogs');
  autoRefreshLogs = document.getElementById('autoRefreshLogs');

  // Content analysis elements
  analyzeRecentPages = document.getElementById('analyzeRecentPages');
  showContentStats = document.getElementById('showContentStats');
  testSearchModes = document.getElementById('testSearchModes');
  contentAnalysis = document.getElementById('contentAnalysis');
  analysisContent = document.getElementById('analysisContent');

  // Preferences
  // Removed allowCloudModel toggle (redundant)
  toggleEnableReranker = document.getElementById('toggleEnableReranker');
  toggleEnableRemoteWarm = document.getElementById('toggleEnableRemoteWarm');
  modelStatusDebug = document.getElementById('modelStatusDebug');
  refreshModelStatusBtn = document.getElementById('refreshModelStatus');
  savePrefs = document.getElementById('savePrefs');
  reloadEmbeddings = document.getElementById('reloadEmbeddings');
  // Permissions
  grantAllSitesAccessBtn = document.getElementById('grantAllSitesAccess');
  grantCurrentSiteAccessBtn = document.getElementById('grantCurrentSiteAccess');
  checkCurrentSiteAccessBtn = document.getElementById('checkCurrentSiteAccess');
  openExtensionSettingsBtn = document.getElementById('openExtensionSettings');

  // Queue elements
  queueLength = document.getElementById('queueLength');
  queueCompleted = document.getElementById('queueCompleted');
  queueFailed = document.getElementById('queueFailed');
  queueStatusIndicator = document.getElementById('queueStatusIndicator');
  queueStatusText = document.getElementById('queueStatusText');
  currentlyProcessing = document.getElementById('currentlyProcessing');
  processingDetails = document.getElementById('processingDetails');
  refreshQueueStats = document.getElementById('refreshQueueStats');
  processQueue = document.getElementById('processQueue');
  clearQueue = document.getElementById('clearQueue');
}

function setupEventListeners() {
  // Statistics
  refreshStats.addEventListener('click', refreshStatistics);

  // Query execution
  executeQuery.addEventListener('click', handleExecuteQuery);
  clearQuery.addEventListener('click', () => {
    sqlQuery.value = '';
    hideQueryResults();
  });
  sampleQueries.addEventListener('click', showSampleQueries);

  // Database management
  clearModelCache.addEventListener('click', handleClearModelCache);
  clearDatabase.addEventListener('click', handleClearDatabase);

  // Logs
  clearLogs.addEventListener('click', handleClearLogs);
  exportLogs.addEventListener('click', handleExportLogs);
  autoRefreshLogs.addEventListener('change', toggleLogRefresh);

  // Content analysis
  analyzeRecentPages.addEventListener('click', handleAnalyzeRecentPages);
  showContentStats.addEventListener('click', handleShowContentStats);
  testSearchModes.addEventListener('click', handleTestSearchModes);

  // Preferences
  if (savePrefs) savePrefs.addEventListener('click', handleSavePrefs);
  if (reloadEmbeddings) reloadEmbeddings.addEventListener('click', handleReloadEmbeddings);
  if (refreshModelStatusBtn) refreshModelStatusBtn.addEventListener('click', updateModelStatusDebug);
  // Permissions
  if (grantAllSitesAccessBtn) grantAllSitesAccessBtn.addEventListener('click', handleGrantAllSitesAccess);
  if (grantCurrentSiteAccessBtn) grantCurrentSiteAccessBtn.addEventListener('click', handleGrantCurrentSiteAccess);
  if (checkCurrentSiteAccessBtn) checkCurrentSiteAccessBtn.addEventListener('click', handleCheckCurrentSiteAccess);
  if (openExtensionSettingsBtn) openExtensionSettingsBtn.addEventListener('click', handleOpenExtensionSettings);

  // Queue management
  if (refreshQueueStats) refreshQueueStats.addEventListener('click', handleRefreshQueueStats);
  if (processQueue) processQueue.addEventListener('click', handleProcessQueue);
  if (clearQueue) clearQueue.addEventListener('click', handleClearQueue);

  // Keyboard shortcuts
  sqlQuery.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleExecuteQuery();
    }
  });
}

// Permissions handlers
async function handleCheckCurrentSiteAccess() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url) { log('No active tab URL found', 'warn'); return; }
    const origin = new URL(tab.url).origin + '/*';
    const has = await chrome.permissions.contains({ origins: [origin] });
    log(`${has ? '✅' : '⛔️'} Host access ${has ? 'granted' : 'missing'} for ${origin}`, has ? 'info' : 'warn');
  } catch (e) {
    log(`Failed to check site access: ${e.message}`, 'error');
  }
}

async function handleGrantCurrentSiteAccess() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url) { log('No active tab URL found', 'warn'); return; }
    const origin = new URL(tab.url).origin + '/*';
    const granted = await chrome.permissions.request({ origins: [origin] });
    log(granted ? `Granted host access for ${origin}` : `User denied host access for ${origin}`, granted ? 'info' : 'warn');
  } catch (e) {
    log(`Failed to request site access: ${e.message}`, 'error');
  }
}

async function handleGrantAllSitesAccess() {
  try {
    const granted = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
    log(granted ? 'Granted host access for all sites' : 'User denied all-sites access', granted ? 'info' : 'warn');
  } catch (e) {
    log(`Failed to request all-sites access: ${e.message}`, 'error');
  }
}

function handleOpenExtensionSettings() {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
}

async function loadPreferences() {
  try {
    const store = await chrome.storage.local.get(['aiPrefs']);
    const prefs = store.aiPrefs || { enableReranker: false, enableRemoteWarm: false };
    if (toggleEnableReranker) toggleEnableReranker.checked = !!prefs.enableReranker;
    if (toggleEnableRemoteWarm) toggleEnableRemoteWarm.checked = !!prefs.enableRemoteWarm;
    // Also refresh model status
    updateModelStatusDebug();
  } catch (e) {
    log('Failed to load preferences', 'warn');
  }
}

async function handleSavePrefs() {
  const prefs = {
    enableReranker: toggleEnableReranker ? toggleEnableReranker.checked : false,
    enableRemoteWarm: toggleEnableRemoteWarm ? toggleEnableRemoteWarm.checked : false
  };
  try {
    await chrome.storage.local.set({ aiPrefs: prefs });
    log('Preferences saved', 'info');
    await chrome.runtime.sendMessage({ type: 'refresh-ai-prefs' });
    await updateModelStatusDebug();
  } catch (e) {
    log(`Failed to save preferences: ${e.message}`, 'error');
  }
}

async function handleReloadEmbeddings() {
  try {
    showProgress();
    const resp = await chrome.runtime.sendMessage({ type: 'reload-embeddings' });
    if (resp?.error) throw new Error(resp.error);
    log('Embeddings reloaded', 'info');
  } catch (e) {
    log(`Failed to reload embeddings: ${e.message}`, 'error');
  } finally {
    hideProgress();
  }
}

// Connection management
async function connectToOffscreen() {
  log('Connecting to offscreen document...', 'info');
  updateStatus('loading', 'Connecting...');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'ping'
    });

    if (response && response.status === 'ok') {
      isConnected = true;
      updateStatus('online', 'Connected');
      log('Connected to offscreen document', 'info');

      // Load initial statistics
      await refreshStatistics();
    } else {
      throw new Error('Invalid response from offscreen document');
    }
  } catch (error) {
    console.error('[DEBUG] Connection failed:', error);
    updateStatus('offline', 'Disconnected');
    log(`Connection failed: ${error.message}`, 'error');

    // Show reload notice if it's a message routing issue
    if (error.message.includes('Unknown message type')) {
      const reloadNotice = document.getElementById('reloadNotice');
      if (reloadNotice) {
        reloadNotice.style.display = 'block';
      }
    }
  }
}

function updateStatus(status, text) {
  statusText.textContent = text;
  statusIndicator.className = `status-indicator status-${status}`;
}

// Statistics management
async function refreshStatistics() {
  if (!isConnected) {
    log('Cannot refresh statistics - not connected', 'warn');
    return;
  }

  log('Refreshing statistics...', 'info');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'get-stats'
    });

    if (response.error) {
      throw new Error(response.error);
    }

    // Update statistics display
    pageCount.textContent = response.pageCount || 0;
    embeddingCount.textContent = response.embeddingCount || 0;

    log('Statistics refreshed successfully', 'info');

    // Also refresh queue stats
    await handleRefreshQueueStats();
  } catch (error) {
    console.error('[DEBUG] Failed to refresh statistics:', error);
    log(`Failed to refresh statistics: ${error.message}`, 'error');
  }
}

// Model status
async function updateModelStatusDebug() {
  if (!modelStatusDebug) return;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get-model-status' });
    const ms = resp && resp.modelStatus ? resp.modelStatus : null;
    if (!ms) { modelStatusDebug.textContent = 'Model: unavailable'; return; }
    if (ms.warming) {
      modelStatusDebug.textContent = 'Model: warming larger remote model… (using local)';
    } else if (ms.using === 'remote') {
      modelStatusDebug.textContent = 'Model: Remote (large)';
    } else {
      modelStatusDebug.textContent = 'Model: Local (quantized)';
    }
    if (ms.lastError) {
      modelStatusDebug.textContent += ` — warm-up failed: ${ms.lastError}`;
    }
  } catch (e) {
    modelStatusDebug.textContent = 'Model: error retrieving status';
  }
}

// Query execution
async function handleExecuteQuery() {
  const query = sqlQuery.value.trim();
  if (!query) {
    log('Please enter a SQL query', 'warn');
    return;
  }

  if (!isConnected) {
    log('Cannot execute query - not connected', 'warn');
    return;
  }

  // Check for write operations without write mode
  const isWriteQuery = /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\s+/i.test(query);
  if (isWriteQuery && !writeMode.checked) {
    log('Write operations require enabling Write Mode', 'warn');
    return;
  }

  log(`Executing query: ${query.substring(0, 100)}${query.length > 100 ? '...' : ''}`, 'info');

  try {
    executeQuery.disabled = true;
    executeQuery.textContent = 'Executing...';

    const response = await chrome.runtime.sendMessage({
      type: 'execute-sql',
      data: {
        query: query,
        writeMode: writeMode.checked
      }
    });

    if (response.error) {
      throw new Error(response.error);
    }

    displayQueryResults(response);
    log('Query executed successfully', 'info');

  } catch (error) {
    console.error('[DEBUG] Query execution failed:', error);
    log(`Query failed: ${error.message}`, 'error');
    hideQueryResults();
  } finally {
    executeQuery.disabled = false;
    executeQuery.textContent = 'Execute Query';
  }
}

function displayQueryResults(response) {
  if (!response.results || response.results.length === 0) {
    resultsContent.innerHTML = `
      <p style="color: #64748b; text-align: center; padding: 20px;">
        Query executed successfully. ${response.changes || 0} rows affected.
      </p>
    `;
    queryResults.classList.remove('hidden');
    return;
  }

  // Create table
  const table = document.createElement('table');
  table.className = 'results-table';

  // Create header
  const headers = Object.keys(response.results[0]);
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  headers.forEach(header => {
    const th = document.createElement('th');
    th.textContent = header;
    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Create body
  const tbody = document.createElement('tbody');

  response.results.forEach(row => {
    const tr = document.createElement('tr');

    headers.forEach(header => {
      const td = document.createElement('td');
      let value = row[header];

      // Format different data types
      if (value === null) {
        td.textContent = 'NULL';
        td.style.color = '#94a3b8';
        td.style.fontStyle = 'italic';
      } else if (typeof value === 'object') {
        td.textContent = JSON.stringify(value);
      } else if (typeof value === 'string' && value.length > 100) {
        td.textContent = value.substring(0, 100) + '...';
        td.title = value;
      } else {
        td.textContent = value;
      }

      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);

  // Display results
  resultsContent.innerHTML = '';
  resultsContent.appendChild(table);

  // Add summary
  const summary = document.createElement('p');
  summary.style.marginTop = '12px';
  summary.style.color = '#64748b';
  summary.style.fontSize = '13px';
  summary.textContent = `${response.results.length} rows returned`;
  resultsContent.appendChild(summary);

  queryResults.classList.remove('hidden');
}

function hideQueryResults() {
  queryResults.classList.add('hidden');
}

function showSampleQueries() {
  const menu = document.createElement('div');
  menu.style.cssText = `
    position: fixed;
    background: white;
    border-radius: 12px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
    padding: 8px;
    z-index: 1000;
    max-height: 300px;
    overflow-y: auto;
    min-width: 300px;
  `;

  SAMPLE_QUERIES.forEach(query => {
    const item = document.createElement('div');
    item.style.cssText = `
      padding: 8px 12px;
      cursor: pointer;
      border-radius: 8px;
      font-family: Monaco, monospace;
      font-size: 12px;
      margin: 2px 0;
    `;
    item.textContent = query;

    item.addEventListener('mouseenter', () => {
      item.style.background = '#f1f5f9';
    });

    item.addEventListener('mouseleave', () => {
      item.style.background = 'transparent';
    });

    item.addEventListener('click', () => {
      sqlQuery.value = query;
      if (document.body.contains(menu)) {
        document.body.removeChild(menu);
      }
      document.removeEventListener('click', closeMenu);
    });

    menu.appendChild(item);
  });

  // Position menu near the button
  const rect = sampleQueries.getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.bottom + 5) + 'px';

  // Close menu when clicking outside
  const closeMenu = (e) => {
    if (!menu.contains(e.target) && document.body.contains(menu)) {
      document.body.removeChild(menu);
      document.removeEventListener('click', closeMenu);
    }
  };

  setTimeout(() => {
    document.addEventListener('click', closeMenu);
  }, 0);

  document.body.appendChild(menu);
}

// Database management

async function handleClearModelCache() {
  if (!confirm('Are you sure you want to clear the model cache? This will remove downloaded AI models and may require re-downloading.')) {
    return;
  }

  if (!isConnected) {
    log('Cannot clear model cache - not connected', 'warn');
    return;
  }

  log('Clearing model cache...', 'info');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'clear-model-cache'
    });

    if (response.error) {
      throw new Error(response.error);
    }

    log('Model cache cleared successfully', 'info');
  } catch (error) {
    console.error('[DEBUG] Failed to clear model cache:', error);
    log(`Failed to clear model cache: ${error.message}`, 'error');
  }
}

async function handleClearDatabase() {
  const confirmation = prompt('Type "DELETE ALL DATA" to confirm clearing the entire database:');
  if (confirmation !== 'DELETE ALL DATA') {
    log('Database clear cancelled', 'info');
    return;
  }

  if (!isConnected) {
    log('Cannot clear database - not connected', 'warn');
    return;
  }

  log('Clearing database...', 'warn');
  showProgress();

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'clear-db'
    });

    if (response.error) {
      throw new Error(response.error);
    }

    log('Database cleared successfully', 'warn');
    await refreshStatistics();
  } catch (error) {
    console.error('[DEBUG] Failed to clear database:', error);
    log(`Failed to clear database: ${error.message}`, 'error');
  } finally {
    hideProgress();
  }
}

// Progress management
function showProgress() {
  operationProgress.classList.remove('hidden');
  progressFill.style.width = '0%';

  // Simulate progress
  let progress = 0;
  const interval = setInterval(() => {
    progress += Math.random() * 20;
    if (progress >= 90) {
      clearInterval(interval);
      progressFill.style.width = '90%';
    } else {
      progressFill.style.width = progress + '%';
    }
  }, 200);

  return interval;
}

function hideProgress() {
  progressFill.style.width = '100%';
  setTimeout(() => {
    operationProgress.classList.add('hidden');
    progressFill.style.width = '0%';
  }, 300);
}

// Logging
function log(message, level = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = {
    timestamp,
    level,
    message
  };

  currentLogs.push(logEntry);

  // Keep only last 100 logs
  if (currentLogs.length > 100) {
    currentLogs = currentLogs.slice(-100);
  }

  updateLogDisplay();
}

function updateLogDisplay() {
  const logsHtml = currentLogs.map(entry => `
    <div class="log-entry">
      <span class="log-timestamp">[${entry.timestamp}]</span>
      <span class="log-level-${entry.level}">[${entry.level.toUpperCase()}]</span>
      ${escapeHtml(entry.message)}
    </div>
  `).join('');

  logContainer.innerHTML = logsHtml;
  logContainer.scrollTop = logContainer.scrollHeight;
}

function handleClearLogs() {
  currentLogs = [];
  updateLogDisplay();
  log('Logs cleared', 'info');
}

function handleExportLogs() {
  const logsText = currentLogs.map(entry =>
    `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`
  ).join('\n');

  const blob = new Blob([logsText], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ai-history-logs-${new Date().toISOString()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  log('Logs exported successfully', 'info');
}

function startLogRefresh() {
  if (autoRefreshLogs.checked) {
    logRefreshInterval = setInterval(() => {
      // Auto-refresh could fetch new logs from background if needed
      // For now, just ensure the display is updated
      updateLogDisplay();
    }, 5000);
  }
}

function toggleLogRefresh() {
  if (logRefreshInterval) {
    clearInterval(logRefreshInterval);
    logRefreshInterval = null;
  }

  if (autoRefreshLogs.checked) {
    startLogRefresh();
  }
}

async function handleAnalyzeRecentPages() {
  log('Analyzing recent pages...', 'info');

  try {
    const query = `
      SELECT
        url, title, domain,
        length(content_text) as content_len,
        summary IS NOT NULL as has_summary,
        visit_count,
        datetime(last_visit_at/1000, 'unixepoch') as last_visit
      FROM pages
      WHERE content_text IS NOT NULL
      ORDER BY last_visit_at DESC
      LIMIT 20
    `;

    const response = await chrome.runtime.sendMessage({
      type: 'execute-sql',
      data: { query, writeMode: false }
    });

    displayAnalysisResults(response, 'Recent Pages Analysis');
  } catch (error) {
    log(`Failed to analyze recent pages: ${error.message}`, 'error');
  }
}

async function handleShowContentStats() {
  log('Generating content statistics...', 'info');

  try {
    const queries = [
      {
        title: 'Overall Content Stats',
        query: `
          SELECT
            COUNT(*) as total_pages,
            COUNT(CASE WHEN content_text IS NOT NULL AND length(content_text) > 100 THEN 1 END) as with_content,
            COUNT(CASE WHEN summary IS NOT NULL THEN 1 END) as with_summary,
            AVG(length(content_text)) as avg_content_length
          FROM pages
        `
      },
      {
        title: 'Content by Domain',
        query: `
          SELECT
            domain,
            COUNT(*) as pages,
            COUNT(CASE WHEN content_text IS NOT NULL THEN 1 END) as with_content,
            AVG(length(content_text)) as avg_content_len
          FROM pages
          GROUP BY domain
          ORDER BY pages DESC
          LIMIT 10
        `
      }
    ];

    let combinedResults = '<h3>Content Statistics</h3>';

    for (const { title, query } of queries) {
      const response = await chrome.runtime.sendMessage({
        type: 'execute-sql',
        data: { query, writeMode: false }
      });

      if (response.success) {
        combinedResults += `<h4>${title}</h4>`;
        combinedResults += formatQueryResults(response);
      }
    }

    contentAnalysis.classList.remove('hidden');
    analysisContent.innerHTML = combinedResults;

  } catch (error) {
    log(`Failed to generate content stats: ${error.message}`, 'error');
  }
}

async function handleTestSearchModes() {
  log('Testing search modes...', 'info');

  const testQuery = 'AI technology';

  try {
    const modes = ['hybrid-rerank', 'hybrid-rrf', 'text', 'vector'];
    let results = '<h3>Search Mode Test Results</h3>';
    results += `<p>Test query: <strong>"${testQuery}"</strong></p>`;

    for (const mode of modes) {
      const response = await chrome.runtime.sendMessage({
        type: 'search',
        data: { query: testQuery, mode: mode, limit: 5 }
      });

      if (response.results) {
        results += `<h4>${mode} (${response.results.length} results)</h4>`;
        results += '<ul>';
        response.results.forEach(result => {
          results += `<li><strong>${escapeHtml(result.title || 'Untitled')}</strong><br>`;
          results += `<small>${escapeHtml(result.url)}</small></li>`;
        });
        results += '</ul>';
      } else {
        results += `<h4>${mode}</h4><p>No results or error</p>`;
      }
    }

    contentAnalysis.classList.remove('hidden');
    analysisContent.innerHTML = results;

  } catch (error) {
    log(`Failed to test search modes: ${error.message}`, 'error');
  }
}

function displayAnalysisResults(response, title) {
  contentAnalysis.classList.remove('hidden');

  if (response.error) {
    analysisContent.innerHTML = `
      <h3>${title}</h3>
      <div style="color: #ef4444;">${escapeHtml(response.error)}</div>
    `;
    return;
  }

  analysisContent.innerHTML = `
    <h3>${title}</h3>
    ${formatQueryResults(response)}
  `;
}

// Utility functions
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatQueryResults(response) {
  if (!response.results || response.results.length === 0) {
    return '<p style="color: #64748b; text-align: center;">No results returned.</p>';
  }

  const headers = Object.keys(response.results[0]);
  let html = '<table class="results-table"><thead><tr>';

  headers.forEach(header => {
    html += `<th>${escapeHtml(header)}</th>`;
  });

  html += '</tr></thead><tbody>';

  response.results.forEach(row => {
    html += '<tr>';
    headers.forEach(header => {
      const value = row[header];
      if (value === null) {
        html += '<td style="color: #94a3b8; font-style: italic;">NULL</td>';
      } else if (typeof value === 'string' && value.length > 50) {
        html += `<td title="${escapeHtml(value)}">${escapeHtml(value.substring(0, 50))}...</td>`;
      } else {
        html += `<td>${escapeHtml(String(value))}</td>`;
      }
    });
    html += '</tr>';
  });

  html += '</tbody></table>';
  html += `<p style="margin-top: 12px; color: #64748b; font-size: 13px;">${response.results.length} rows returned</p>`;

  return html;
}

// Queue management functions
async function handleRefreshQueueStats() {
  if (!isConnected) {
    log('Cannot refresh queue stats - not connected', 'warn');
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-summary-queue-stats' });

    if (response.error) {
      throw new Error(response.error);
    }

    const stats = response.stats;

    // Update queue statistics display
    queueLength.textContent = stats.queueLength || 0;
    queueCompleted.textContent = stats.completed || 0;
    queueFailed.textContent = stats.failed || 0;

    // Update queue status
    if (stats.isProcessing) {
      queueStatusText.textContent = 'Processing';
      queueStatusIndicator.className = 'status-indicator status-loading';
    } else if (stats.queueLength > 0) {
      queueStatusText.textContent = 'Waiting';
      queueStatusIndicator.className = 'status-indicator status-offline';
    } else {
      queueStatusText.textContent = 'Idle';
      queueStatusIndicator.className = 'status-indicator status-online';
    }

    // Show/hide currently processing section
    if (stats.currentlyProcessing) {
      const proc = stats.currentlyProcessing;
      processingDetails.innerHTML = `
        <strong>${escapeHtml(proc.title)}</strong><br>
        <span style="color: #7dd3fc;">${escapeHtml(proc.domain)}</span> •
        <span>Attempt ${proc.attempt}/${proc.maxAttempts}</span><br>
        <small style="color: #94a3b8;">${escapeHtml(proc.url)}</small>
      `;
      currentlyProcessing.style.display = 'block';
    } else {
      currentlyProcessing.style.display = 'none';
    }

    log(`Queue stats: ${stats.queueLength} queued, ${stats.completed} completed, ${stats.failed} failed`, 'info');

  } catch (error) {
    console.error('[DEBUG] Failed to refresh queue stats:', error);
    log(`Failed to refresh queue stats: ${error.message}`, 'error');
  }
}

async function handleProcessQueue() {
  if (!isConnected) {
    log('Cannot process queue - not connected', 'warn');
    return;
  }

  try {
    log('Starting queue processing...', 'info');
    const response = await chrome.runtime.sendMessage({ type: 'process-summary-queue' });

    if (response.error) {
      throw new Error(response.error);
    }

    log(response.message || 'Queue processing started', 'info');

    // Refresh stats after a short delay
    setTimeout(() => {
      handleRefreshQueueStats();
    }, 1000);

  } catch (error) {
    console.error('[DEBUG] Failed to process queue:', error);
    log(`Failed to process queue: ${error.message}`, 'error');
  }
}

async function handleClearQueue() {
  if (!confirm('Are you sure you want to clear the summarization queue? This will remove all pending summarization tasks.')) {
    return;
  }

  if (!isConnected) {
    log('Cannot clear queue - not connected', 'warn');
    return;
  }

  try {
    log('Clearing summarization queue...', 'warn');
    const response = await chrome.runtime.sendMessage({ type: 'clear-summary-queue' });

    if (response.error) {
      throw new Error(response.error);
    }

    log(response.message || 'Queue cleared', 'warn');

    // Refresh stats immediately
    await handleRefreshQueueStats();

  } catch (error) {
    console.error('[DEBUG] Failed to clear queue:', error);
    log(`Failed to clear queue: ${error.message}`, 'error');
  }
}

// Auto-refresh queue stats periodically
setInterval(() => {
  if (isConnected) {
    handleRefreshQueueStats();
  }
}, 10000); // Every 10 seconds

// Export for debugging
window.debugPageController = {
  refreshStatistics,
  connectToOffscreen,
  currentLogs,
  isConnected,
  handleTestSearchModes,
  handleRefreshQueueStats,
  handleProcessQueue,
  handleClearQueue
};
