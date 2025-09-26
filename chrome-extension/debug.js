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
// Queue debugging elements
let addTestItem, addMultipleItems, testNotifications, startMonitoring, stopMonitoring;
let showTimeline, resetStuckItems, cleanupOldItems, showQueueQueries;

// Content analysis elements
let analyzeRecentPages, showContentStats, testSearchModes;
let contentAnalysis, analysisContent;

// Chrome AI testing elements
let chromeAiStatus, summarizerStatus, keywordExtractorStatus;
let checkChromeAI, testKeywordExtraction, testSummarizer, testFullChatFlow;
let chromeAiTestResults, chromeAiTestContent;
let testQuery, testContent;

// State
let isConnected = false;
let currentLogs = [];
let logRefreshInterval = null;

// Sample queries for convenience - Chrome Extension specific
const SAMPLE_QUERIES = [
  // Basic inspection
  'SELECT * FROM pages LIMIT 5;',
  'SELECT tablename as name, schemaname FROM pg_tables WHERE schemaname = \'public\';',
  '\\d pages',

  // Extension functionality checks
  'SELECT extname, extversion FROM pg_extension WHERE extname = \'vector\';',
  'SELECT COUNT(*) as total_pages FROM pages;',
  'SELECT COUNT(*) as pages_with_embeddings FROM pages WHERE embedding IS NOT NULL;',

  // Recent browsing history
  'SELECT title, url, domain, last_visit_at, visit_count FROM pages ORDER BY last_visit_at DESC LIMIT 10;',
  'SELECT domain, COUNT(*) as page_count FROM pages GROUP BY domain ORDER BY page_count DESC LIMIT 10;',

  // Search functionality testing (PostgreSQL FTS)
  'SELECT title, url FROM pages WHERE content_tsvector @@ plainto_tsquery(\'english\', \'AI\') LIMIT 5;',
  'SELECT id, title, url, embedding <=> \'[0.1,0.2,0.3]\' AS distance FROM pages WHERE embedding IS NOT NULL LIMIT 5;',

  // Extension debugging
  'SELECT COUNT(*) as pages_with_tsvector FROM pages WHERE content_tsvector IS NOT NULL;',
  'SELECT url, title, char_length(content_text) as content_length FROM pages WHERE content_text IS NOT NULL LIMIT 5;',

  // Content extraction analysis
  'SELECT url, title, char_length(content_text) as content_len, summary IS NOT NULL as has_summary FROM pages WHERE content_text IS NOT NULL ORDER BY last_visit_at DESC LIMIT 10;',
  'SELECT domain, COUNT(*) as pages, AVG(char_length(content_text)) as avg_content_len FROM pages WHERE content_text IS NOT NULL GROUP BY domain ORDER BY pages DESC LIMIT 10;',
  'SELECT COUNT(*) as with_content, (SELECT COUNT(*) FROM pages) as total FROM pages WHERE content_text IS NOT NULL AND char_length(content_text) > 100;',

  // Performance analysis
  'SELECT domain, AVG(visit_count) as avg_visits, COUNT(*) as pages FROM pages GROUP BY domain HAVING COUNT(*) > 1 ORDER BY avg_visits DESC LIMIT 10;',
  'SELECT title, url, visit_count FROM pages ORDER BY visit_count DESC LIMIT 10;',

  // Vector search examples
  'SELECT title, url, 1 - (embedding <=> \'[0.1,0.2,0.3]\') AS similarity FROM pages WHERE embedding IS NOT NULL ORDER BY embedding <=> \'[0.1,0.2,0.3]\' LIMIT 5;',
  'SELECT COUNT(*) as vector_indexed FROM pages WHERE embedding IS NOT NULL;',

  // === AI SUMMARIZATION QUEUE DEBUGGING ===
  // Queue overview and status
  'SELECT status, COUNT(*) as count FROM summarization_queue GROUP BY status ORDER BY status;',
  'SELECT COUNT(*) as total_items FROM summarization_queue;',

  // Pending items (ready for processing)
  'SELECT id, url, title, domain, attempts, created_at FROM summarization_queue WHERE status = \'pending\' ORDER BY created_at ASC LIMIT 10;',

  // Failed items (need attention)
  'SELECT url, title, attempts, status, created_at, processed_at FROM summarization_queue WHERE status = \'failed\' ORDER BY created_at DESC LIMIT 10;',

  // Currently processing items
  'SELECT id, url, title, status, attempts, created_at FROM summarization_queue WHERE status = \'processing\' ORDER BY created_at ASC;',

  // Queue processing statistics
  'SELECT status, COUNT(*) as count, AVG(attempts) as avg_attempts FROM summarization_queue WHERE processed_at IS NOT NULL GROUP BY status;',

  // Recent queue activity (last 50 items)
  'SELECT url, title, status, attempts, created_at, processed_at FROM summarization_queue ORDER BY COALESCE(processed_at, created_at) DESC LIMIT 50;',

  // Retry statistics
  'SELECT attempts, COUNT(*) as count FROM summarization_queue GROUP BY attempts ORDER BY attempts;',

  // Queue performance analysis
  'SELECT status, MIN(created_at) as oldest, MAX(created_at) as newest, COUNT(*) as count FROM summarization_queue GROUP BY status;',

  // Items stuck in processing (potential issues)
  'SELECT id, url, title, attempts, created_at FROM summarization_queue WHERE status = \'processing\' AND created_at < NOW() - INTERVAL \'10 minutes\';',

  // Queue table structure
  '\\d summarization_queue',

  // === QUEUE MANAGEMENT QUERIES (Write Mode Required) ===
  // Reset stuck processing items back to pending
  'UPDATE summarization_queue SET status = \'pending\' WHERE status = \'processing\' AND created_at < NOW() - INTERVAL \'10 minutes\';',

  // Clear completed items older than 7 days
  'DELETE FROM summarization_queue WHERE status IN (\'completed\', \'failed\') AND processed_at < NOW() - INTERVAL \'7 days\';',

  // Reset failed items for retry (use carefully)
  'UPDATE summarization_queue SET status = \'pending\', attempts = 0 WHERE status = \'failed\';',

  // Clear entire queue (nuclear option)
  'TRUNCATE TABLE summarization_queue RESTART IDENTITY;'
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

  // Chrome AI testing elements
  chromeAiStatus = document.getElementById('chromeAiStatus');
  summarizerStatus = document.getElementById('summarizerStatus');
  keywordExtractorStatus = document.getElementById('keywordExtractorStatus');
  checkChromeAI = document.getElementById('checkChromeAI');
  testKeywordExtraction = document.getElementById('testKeywordExtraction');
  testSummarizer = document.getElementById('testSummarizer');
  testFullChatFlow = document.getElementById('testFullChatFlow');
  chromeAiTestResults = document.getElementById('chromeAiTestResults');
  chromeAiTestContent = document.getElementById('chromeAiTestContent');
  testQuery = document.getElementById('testQuery');
  testContent = document.getElementById('testContent');

  // Preferences
  // Removed allowCloudModel toggle (redundant)
  toggleEnableReranker = document.getElementById('toggleEnableReranker');
  toggleEnableRemoteWarm = document.getElementById('toggleEnableRemoteWarm');
  toggleDisableInputDuringProcessing = document.getElementById('toggleDisableInputDuringProcessing');
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

  // Queue debugging elements
  addTestItem = document.getElementById('addTestItem');
  addMultipleItems = document.getElementById('addMultipleItems');
  testNotifications = document.getElementById('testNotifications');
  startMonitoring = document.getElementById('startMonitoring');
  stopMonitoring = document.getElementById('stopMonitoring');
  showTimeline = document.getElementById('showTimeline');
  resetStuckItems = document.getElementById('resetStuckItems');
  cleanupOldItems = document.getElementById('cleanupOldItems');
  showQueueQueries = document.getElementById('showQueueQueries');
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

  // Chrome AI testing
  if (checkChromeAI) checkChromeAI.addEventListener('click', handleCheckChromeAI);
  if (testKeywordExtraction) testKeywordExtraction.addEventListener('click', handleTestKeywordExtraction);
  if (testSummarizer) testSummarizer.addEventListener('click', handleTestSummarizer);
  if (testFullChatFlow) testFullChatFlow.addEventListener('click', handleTestFullChatFlow);

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

  // Queue debugging tools
  if (addTestItem) addTestItem.addEventListener('click', addTestQueueItem);
  if (addMultipleItems) addMultipleItems.addEventListener('click', () => addMultipleTestItems(5));
  if (testNotifications) testNotifications.addEventListener('click', testQueueNotifications);
  if (startMonitoring) startMonitoring.addEventListener('click', startQueueMonitoring);
  if (stopMonitoring) stopMonitoring.addEventListener('click', stopQueueMonitoring);
  if (showTimeline) showTimeline.addEventListener('click', showQueueTimeline);
  if (resetStuckItems) resetStuckItems.addEventListener('click', handleResetStuckItems);
  if (cleanupOldItems) cleanupOldItems.addEventListener('click', handleCleanupOldItems);
  if (showQueueQueries) showQueueQueries.addEventListener('click', showQueueSampleQueries);

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
    const prefs = store.aiPrefs || { enableReranker: false, enableRemoteWarm: false, disableInputDuringProcessing: false };
    if (toggleEnableReranker) toggleEnableReranker.checked = !!prefs.enableReranker;
    if (toggleEnableRemoteWarm) toggleEnableRemoteWarm.checked = !!prefs.enableRemoteWarm;
    if (toggleDisableInputDuringProcessing) toggleDisableInputDuringProcessing.checked = !!prefs.disableInputDuringProcessing;
    // Also refresh model status
    updateModelStatusDebug();
  } catch (e) {
    log('Failed to load preferences', 'warn');
  }
}

async function handleSavePrefs() {
  const prefs = {
    enableReranker: toggleEnableReranker ? toggleEnableReranker.checked : false,
    enableRemoteWarm: toggleEnableRemoteWarm ? toggleEnableRemoteWarm.checked : false,
    disableInputDuringProcessing: toggleDisableInputDuringProcessing ? toggleDisableInputDuringProcessing.checked : false
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
    }, 2000);
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

// === QUEUE DEBUGGING FUNCTIONS ===

// Add manual test items to the queue for testing
async function addTestQueueItem() {
  try {
    const testUrl = `https://example.com/test-${Date.now()}`;
    const testData = {
      title: `Test Page ${new Date().toLocaleTimeString()}`,
      domain: 'example.com',
      text: 'This is test content for the summarization queue. '.repeat(10) +
            'It contains enough text to trigger summarization processing. '.repeat(5) +
            'This helps us test the queue functionality and LISTEN/NOTIFY system.'
    };

    log(`Adding test queue item: ${testUrl}`, 'info');

    // Send message to offscreen to add queue item
    const response = await chrome.runtime.sendMessage({
      type: 'ingest-captured-payload',
      data: {
        url: testUrl,
        title: testData.title,
        domain: testData.domain,
        text: testData.text,
        timestamp: Date.now()
      }
    });

    if (response.error) {
      throw new Error(response.error);
    }

    log(`✅ Test queue item added successfully: ${testUrl}`, 'info');

    // Refresh queue stats to show the new item
    setTimeout(() => handleRefreshQueueStats(), 500);

  } catch (error) {
    log(`❌ Failed to add test queue item: ${error.message}`, 'error');
    console.error('[DEBUG] Add test queue item failed:', error);
  }
}

// Add multiple test items for load testing
async function addMultipleTestItems(count = 5) {
  log(`Adding ${count} test queue items for load testing...`, 'info');

  for (let i = 0; i < count; i++) {
    await addTestQueueItem();
    // Small delay to avoid overwhelming the system
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  log(`✅ Added ${count} test queue items`, 'info');
}

// Monitor queue processing in real-time
let queueMonitorInterval = null;

function startQueueMonitoring() {
  if (queueMonitorInterval) {
    clearInterval(queueMonitorInterval);
  }

  log('🔍 Starting real-time queue monitoring...', 'info');

  queueMonitorInterval = setInterval(async () => {
    try {
      const statsResponse = await chrome.runtime.sendMessage({
        type: 'get-summary-queue-stats'
      });

      if (statsResponse.error) {
        throw new Error(statsResponse.error);
      }

      const stats = statsResponse.stats;

      // Only log changes to reduce noise
      const currentState = JSON.stringify(stats);
      if (currentState !== window.lastQueueState) {
        log(`Queue update: ${stats.queued} queued, ${stats.processing} processing, ${stats.completed} completed, ${stats.failed} failed`, 'debug');
        window.lastQueueState = currentState;

        // Update the UI stats
        handleRefreshQueueStats();
      }

      // Alert if queue is stuck
      if (stats.processing > 0 && stats.currentlyProcessing) {
        const processingTime = Date.now() - new Date(stats.currentlyProcessing.startTime || 0).getTime();
        if (processingTime > 5 * 60 * 1000) { // 5 minutes
          log(`⚠️ Queue item stuck processing for ${Math.round(processingTime/60000)} minutes: ${stats.currentlyProcessing.url}`, 'warn');
        }
      }

    } catch (error) {
      log(`Queue monitoring error: ${error.message}`, 'error');
    }
  }, 1000); // Check every second during monitoring
}

function stopQueueMonitoring() {
  if (queueMonitorInterval) {
    clearInterval(queueMonitorInterval);
    queueMonitorInterval = null;
    log('🔍 Stopped queue monitoring', 'info');
  }
}

// Test LISTEN/NOTIFY functionality
async function testQueueNotifications() {
  log('🧪 Testing queue LISTEN/NOTIFY functionality...', 'info');

  try {
    // Add a test item and monitor for immediate processing
    startQueueMonitoring();

    await addTestQueueItem();

    // Check if processing started within 2 seconds (should be immediate with LISTEN/NOTIFY)
    setTimeout(async () => {
      const statsResponse = await chrome.runtime.sendMessage({
        type: 'get-summary-queue-stats'
      });

      if (statsResponse.stats.processing > 0 || statsResponse.stats.completed > 0) {
        log('✅ LISTEN/NOTIFY working - processing started immediately', 'info');
      } else {
        log('⚠️ LISTEN/NOTIFY may not be working - no immediate processing detected', 'warn');
      }

      stopQueueMonitoring();
    }, 2000);

  } catch (error) {
    log(`❌ Queue notification test failed: ${error.message}`, 'error');
    stopQueueMonitoring();
  }
}

// Reset stuck items back to pending
async function handleResetStuckItems() {
  log('🔧 Resetting stuck processing items...', 'info');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'execute-sql',
      data: {
        query: "UPDATE summarization_queue SET status = 'pending' WHERE status = 'processing' AND created_at < NOW() - INTERVAL '10 minutes';",
        writeMode: true
      }
    });

    if (response.error) {
      throw new Error(response.error);
    }

    const rowsUpdated = response.rowCount || 0;
    log(`✅ Reset ${rowsUpdated} stuck items back to pending`, 'info');

    // Refresh stats
    handleRefreshQueueStats();

  } catch (error) {
    log(`❌ Failed to reset stuck items: ${error.message}`, 'error');
  }
}

// Show queue processing timeline
async function showQueueTimeline() {
  log('📊 Generating queue processing timeline...', 'info');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'execute-sql',
      data: {
        query: `
          SELECT
            url, title, status, attempts,
            created_at, processed_at,
            CASE
              WHEN processed_at IS NOT NULL THEN
                EXTRACT(EPOCH FROM (processed_at - created_at))
              ELSE NULL
            END as processing_time_seconds
          FROM summarization_queue
          ORDER BY created_at DESC
          LIMIT 20;
        `,
        writeMode: false
      }
    });

    if (response.error) {
      throw new Error(response.error);
    }

    displayQueryResults(response);
    log('✅ Queue timeline generated successfully', 'info');

  } catch (error) {
    log(`❌ Failed to generate queue timeline: ${error.message}`, 'error');
  }
}

// Handle cleanup of old queue items
async function handleCleanupOldItems() {
  log('🧹 Cleaning up old queue items...', 'info');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'execute-sql',
      data: {
        query: "DELETE FROM summarization_queue WHERE status IN ('completed', 'failed') AND processed_at < NOW() - INTERVAL '7 days';",
        writeMode: true
      }
    });

    if (response.error) {
      throw new Error(response.error);
    }

    const rowsDeleted = response.rowCount || 0;
    log(`✅ Cleaned up ${rowsDeleted} old queue items`, 'info');

    // Refresh stats
    handleRefreshQueueStats();

  } catch (error) {
    log(`❌ Failed to cleanup old items: ${error.message}`, 'error');
  }
}

// Show sample queries focused on queue debugging
function showQueueSampleQueries() {
  const queueQueries = [
    'SELECT status, COUNT(*) as count FROM summarization_queue GROUP BY status ORDER BY status;',
    'SELECT id, url, title, domain, attempts, created_at FROM summarization_queue WHERE status = \'pending\' ORDER BY created_at ASC LIMIT 10;',
    'SELECT url, title, attempts, status, created_at, processed_at FROM summarization_queue WHERE status = \'failed\' ORDER BY created_at DESC LIMIT 10;',
    'SELECT id, url, title, status, attempts, created_at FROM summarization_queue WHERE status = \'processing\' ORDER BY created_at ASC;',
    'SELECT attempts, COUNT(*) as count FROM summarization_queue GROUP BY attempts ORDER BY attempts;'
  ];

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
    min-width: 400px;
  `;

  // Add title
  const title = document.createElement('div');
  title.style.cssText = `
    padding: 8px 12px;
    font-weight: 600;
    border-bottom: 1px solid #e2e8f0;
    margin-bottom: 4px;
    color: #475569;
  `;
  title.textContent = 'Queue Debugging Queries';
  menu.appendChild(title);

  queueQueries.forEach(query => {
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
  const rect = showQueueQueries.getBoundingClientRect();
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

// Chrome AI Testing Functions
async function handleCheckChromeAI() {
  try {
    showChromeAITestResults('Checking Chrome AI availability...');

    // Import AI Bridge for testing
    const { aiBridge } = await import('./bridge/ai-bridge.js');
    const { keywordExtractor } = await import('./bridge/keyword-extractor.js');

    let results = '<h3>Chrome AI Status Check</h3>';

    // Check AI Bridge initialization
    try {
      await aiBridge.initialize();
      const capabilities = aiBridge.getCapabilities();

      results += '<h4>Language Model:</h4>';
      results += `<pre>${JSON.stringify(capabilities.languageModel, null, 2)}</pre>`;

      results += '<h4>Summarizer:</h4>';
      results += `<pre>${JSON.stringify(capabilities.summarizer, null, 2)}</pre>`;

      // Update status indicators
      updateChromeAIStatus(capabilities);

    } catch (error) {
      results += `<div style="color: red;">AI Bridge Error: ${error.message}</div>`;
      chromeAiStatus.textContent = 'Error';
      summarizerStatus.textContent = 'Error';
    }

    // Test keyword extractor
    try {
      // Just check if it initializes
      results += '<h4>Keyword Extractor:</h4>';
      results += 'Ready for testing';
      keywordExtractorStatus.textContent = 'Ready';
    } catch (error) {
      results += `<div style="color: red;">Keyword Extractor Error: ${error.message}</div>`;
      keywordExtractorStatus.textContent = 'Error';
    }

    showChromeAITestResults(results);

  } catch (error) {
    showChromeAITestResults(`<div style="color: red;">Chrome AI Check Failed: ${error.message}</div>`);
  }
}

async function handleTestKeywordExtraction() {
  try {
    const query = testQuery.value.trim() || 'Find me JavaScript tutorials I visited last week';
    showChromeAITestResults(`Testing keyword extraction for: "${query}"...`);

    const { keywordExtractor } = await import('./bridge/keyword-extractor.js');

    const startTime = performance.now();
    const result = await keywordExtractor.extractKeywords(query);
    const duration = Math.round(performance.now() - startTime);

    let resultsHtml = `<h3>Keyword Extraction Test</h3>`;
    resultsHtml += `<p><strong>Query:</strong> "${query}"</p>`;
    resultsHtml += `<p><strong>Duration:</strong> ${duration}ms</p>`;
    resultsHtml += `<pre>${JSON.stringify(result, null, 2)}</pre>`;

    showChromeAITestResults(resultsHtml);

  } catch (error) {
    showChromeAITestResults(`<div style="color: red;">Keyword Extraction Failed: ${error.message}</div>`);
  }
}

async function handleTestSummarizer() {
  try {
    const content = testContent.value.trim() || 'This is test content for summarization.';
    showChromeAITestResults(`Testing summarizer with ${content.length} characters...`);

    const { aiBridge } = await import('./bridge/ai-bridge.js');

    await aiBridge.initialize();

    const startTime = performance.now();
    const summary = await aiBridge.summarize(content, { type: 'tldr', length: 'short' });
    const duration = Math.round(performance.now() - startTime);

    let resultsHtml = `<h3>Summarizer Test</h3>`;
    resultsHtml += `<p><strong>Input Length:</strong> ${content.length} characters</p>`;
    resultsHtml += `<p><strong>Duration:</strong> ${duration}ms</p>`;
    resultsHtml += `<h4>Summary:</h4>`;
    resultsHtml += `<div style="background: #f8fafc; padding: 12px; border-radius: 8px;">${summary}</div>`;

    showChromeAITestResults(resultsHtml);

  } catch (error) {
    showChromeAITestResults(`<div style="color: red;">Summarizer Test Failed: ${error.message}</div>`);
  }
}

async function handleTestFullChatFlow() {
  try {
    const query = testQuery.value.trim() || 'Find me JavaScript tutorials I visited last week';
    showChromeAITestResults(`Testing full chat flow for: "${query}"...`);

    let resultsHtml = `<h3>Full Chat Flow Test</h3>`;
    resultsHtml += `<p><strong>Query:</strong> "${query}"</p>`;

    // Step 1: Keyword extraction
    resultsHtml += `<h4>Step 1: Keyword Extraction</h4>`;
    const { keywordExtractor } = await import('./bridge/keyword-extractor.js');
    const startTime = performance.now();

    const keywords = await keywordExtractor.extractKeywords(query);
    resultsHtml += `<pre>${JSON.stringify(keywords, null, 2)}</pre>`;

    // Step 2: Search with keywords
    resultsHtml += `<h4>Step 2: Search with Keywords</h4>`;
    const searchResponse = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'search',
      data: { query, keywords, mode: 'hybrid-rerank', limit: 5 }
    });

    if (searchResponse.error) {
      throw new Error(searchResponse.error);
    }

    resultsHtml += `<p>Found ${searchResponse.results?.length || 0} results</p>`;
    resultsHtml += `<pre>${JSON.stringify(searchResponse.results?.slice(0, 2) || [], null, 2)}</pre>`;

    // Step 3: AI Response Generation
    resultsHtml += `<h4>Step 3: AI Response Generation</h4>`;
    const { aiBridge } = await import('./bridge/ai-bridge.js');
    await aiBridge.initialize();

    const searchResults = searchResponse.results || [];
    const context = aiBridge.buildContext(searchResults, 5);

    const response = await aiBridge.generateResponse(query, context);
    const duration = Math.round(performance.now() - startTime);

    resultsHtml += `<p><strong>Total Duration:</strong> ${duration}ms</p>`;
    resultsHtml += `<h4>AI Response:</h4>`;
    resultsHtml += `<div style="background: #f8fafc; padding: 12px; border-radius: 8px;">${response}</div>`;

    showChromeAITestResults(resultsHtml);

  } catch (error) {
    showChromeAITestResults(`<div style="color: red;">Full Chat Flow Test Failed: ${error.message}</div>`);
  }
}

function updateChromeAIStatus(capabilities) {
  if (capabilities.languageModel) {
    const status = capabilities.languageModel.available || 'unknown';
    chromeAiStatus.textContent = status;
  }

  if (capabilities.summarizer) {
    const status = capabilities.summarizer.available || 'unknown';
    summarizerStatus.textContent = status;
  }
}

function showChromeAITestResults(content) {
  chromeAiTestContent.innerHTML = content;
  chromeAiTestResults.classList.remove('hidden');
}

// Auto-refresh queue stats periodically
setInterval(() => {
  if (isConnected) {
    handleRefreshQueueStats();
  }
}, 2000); // Every 2 seconds

// Export for debugging
window.debugPageController = {
  refreshStatistics,
  connectToOffscreen,
  currentLogs,
  isConnected,
  handleTestSearchModes,
  handleRefreshQueueStats,
  handleProcessQueue,
  handleClearQueue,
  // Queue debugging functions
  addTestQueueItem,
  addMultipleTestItems,
  startQueueMonitoring,
  stopQueueMonitoring,
  testQueueNotifications,
  handleResetStuckItems,
  showQueueTimeline,
  handleCleanupOldItems,
  showQueueSampleQueries
};
