/**
 * AI-Powered Browser History - Offscreen Document
 * Handles SQLite database, embeddings, and heavy processing tasks
 */

console.log('[OFFSCREEN] Initializing offscreen document');

// Database and ML state
let db = null;
let embedModel = null;
let isInitialized = false;

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[OFFSCREEN] Message received:', message.type);

  handleMessage(message, sendResponse);
  return true; // Keep message channel open for async responses
});

async function handleMessage(message, sendResponse) {
  try {
    if (!isInitialized && message.type !== 'init') {
      await initialize();
    }

    switch (message.type) {
      case 'init':
        await initialize();
        sendResponse({ status: 'initialized' });
        break;

      case 'ingest-page':
        const result = await ingestPage(message.data);
        sendResponse(result);
        break;

      case 'search':
        const searchResults = await search(message.data);
        sendResponse(searchResults);
        break;

      case 'embed':
        const embeddings = await embed(message.data.text);
        sendResponse({ embeddings });
        break;

      case 'clear-db':
        await clearDatabase();
        sendResponse({ status: 'cleared' });
        break;

      case 'get-stats':
        const stats = await getDatabaseStats();
        sendResponse(stats);
        break;

      case 'ping':
        sendResponse({ status: 'ok', initialized: isInitialized });
        break;

      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
  } catch (error) {
    console.error('[OFFSCREEN] Error handling message:', error);
    sendResponse({ error: error.message });
  }
}

// Initialization
async function initialize() {
  if (isInitialized) return;

  console.log('[OFFSCREEN] Starting initialization...');

  try {
    // Initialize SQLite database
    await initializeDatabase();

    // Initialize embedding model
    await initializeEmbeddings();

    isInitialized = true;
    console.log('[OFFSCREEN] Initialization complete');
  } catch (error) {
    console.error('[OFFSCREEN] Initialization failed:', error);
    throw error;
  }
}

// Database initialization
async function initializeDatabase() {
  console.log('[DB] Initializing SQLite database...');

  // TODO: Import and initialize sqlite-vec WASM
  // For now, create a mock database interface
  db = {
    initialized: true,
    // Mock methods to be replaced with real SQLite implementation
    async insert(table, data) {
      console.log(`[DB] Mock insert into ${table}:`, data);
      return { id: Date.now() };
    },
    async search(query, options = {}) {
      console.log(`[DB] Mock search:`, query, options);
      return [];
    },
    async stats() {
      return { pageCount: 0, embeddingCount: 0 };
    },
    async clear() {
      console.log('[DB] Mock database cleared');
    }
  };

  console.log('[DB] Database initialized (mock)');
}

// Embeddings initialization
async function initializeEmbeddings() {
  console.log('[ML] Initializing embedding model...');

  // TODO: Import and initialize Transformers.js
  // For now, create a mock embedding interface
  embedModel = {
    initialized: true,
    async embed(text) {
      console.log('[ML] Mock embedding for text:', text.substring(0, 100) + '...');
      // Return mock 384-dimensional embedding
      return new Float32Array(384).fill(0).map(() => Math.random() - 0.5);
    }
  };

  console.log('[ML] Embedding model initialized (mock)');
}

// Page ingestion
async function ingestPage(pageInfo) {
  console.log('[OFFSCREEN] Ingesting page:', pageInfo.url);

  try {
    // Extract page content (mock for now)
    const content = await extractPageContent(pageInfo);

    // Generate embedding
    const embedding = await embed(content.title + ' ' + content.text);

    // Store in database
    const pageId = await db.insert('pages', {
      url: pageInfo.url,
      title: content.title,
      content_text: content.text,
      domain: new URL(pageInfo.url).hostname,
      first_visit_at: pageInfo.visitTime || Date.now(),
      last_visit_at: pageInfo.visitTime || Date.now(),
      visit_count: 1
    });

    await db.insert('page_embeddings', {
      id: pageId.id,
      embedding: embedding,
      updated_at: Date.now()
    });

    return { status: 'success', pageId: pageId.id };
  } catch (error) {
    console.error('[OFFSCREEN] Failed to ingest page:', error);
    return { error: error.message };
  }
}

// Content extraction (mock)
async function extractPageContent(pageInfo) {
  // TODO: Implement real content extraction with scripting API
  return {
    title: pageInfo.title || 'Untitled',
    text: `Mock content for ${pageInfo.url}`,
    summary: null
  };
}

// Search implementation
async function search({ query, mode = 'hybrid-rerank', limit = 25 }) {
  console.log('[OFFSCREEN] Searching:', query, 'mode:', mode);

  try {
    // Generate query embedding
    const queryEmbedding = await embed(query);

    // Perform search based on mode
    const results = await db.search(query, {
      mode,
      limit,
      queryEmbedding
    });

    return { results };
  } catch (error) {
    console.error('[OFFSCREEN] Search failed:', error);
    return { error: error.message };
  }
}

// Embedding function
async function embed(text) {
  if (!embedModel?.initialized) {
    throw new Error('Embedding model not initialized');
  }

  return await embedModel.embed(text);
}

// Database utilities
async function clearDatabase() {
  console.log('[OFFSCREEN] Clearing database...');
  if (db) {
    await db.clear();
  }
}

async function getDatabaseStats() {
  if (!db) {
    return { error: 'Database not initialized' };
  }

  return await db.stats();
}

// Initialize on load
initialize().catch(error => {
  console.error('[OFFSCREEN] Failed to initialize:', error);
});