/**
 * AI-Powered Browser History - Offscreen Document
 * Handles PGlite database, embeddings, and heavy processing tasks
 */
import { logger } from './utils/logger.js';

// Initialize offscreen document

// Database and ML state
let db = null;
let embedModel = null;
let embedder = null; // Transformers.js pipeline
let modelStatus = {
  using: 'local', // 'local' | 'remote'
  warming: false,
  lastError: null
};
let isInitialized = false;
let isInitializing = false;
let initializationPromise = null;
let aiPrefs = { enableReranker: false, enableRemoteWarm: false };

// Summarization queue state
let summarizationQueue = [];
let isProcessingSummaries = false;
let summaryQueueStats = {
  queued: 0,
  processing: 0,
  completed: 0,
  failed: 0,
  currentlyProcessing: null
};

// Message handling
// Define messages that this offscreen document should handle
const OFFSCREEN_MESSAGE_TYPES = new Set([
  'init', 'ingest-page', 'ingest-captured-payload', 'ingest-captured-queue',
  'search', 'get-browser-history', 'embed', 'clear-db', 'get-stats', 'page-exists',
  'execute-sql', 'clear-model-cache', 'export-db', 'import-db', 'update-summary',
  'ping', 'refresh-ai-prefs', 'reload-embeddings', 'get-model-status',
  'start-remote-warm', 'get-summary-queue-stats', 'process-summary-queue',
  'clear-summary-queue', 'save-chat-message', 'get-chat-messages', 'clear-chat-thread',
  'get-chat-thread-stats', 'deduplicate-chat-messages'
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages intended for the offscreen document
  if (!OFFSCREEN_MESSAGE_TYPES.has(message.type)) {
    return; // Let other contexts handle this message
  }

  handleMessage(message, sendResponse);
  return true; // Keep message channel open for async responses
});

async function handleMessage(message, sendResponse) {
  try {
    if (!isInitialized && message.type !== 'init') {
      // If initialization is in progress, wait for it to complete
      if (isInitializing && initializationPromise) {
        await initializationPromise;
      } else {
        await initialize();
      }
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

      case 'ingest-captured-payload':
        const capturedResult = await ingestCapturedContent(message.data);
        sendResponse(capturedResult);
        break;

      case 'ingest-captured-queue':
        const queueResult = await ingestCapturedQueue();
        sendResponse(queueResult);
        break;

      case 'search':
        const searchResults = await search(message.data);
        sendResponse(searchResults);
        break;

      case 'get-browser-history':
        const browserHistory = await getBrowserHistory(message.data);
        sendResponse(browserHistory);
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

      case 'page-exists':
        const exists = await db.pageExists(message.data.url);
        sendResponse({ exists });
        break;

      case 'execute-sql':
        const sqlResult = await executeSQL(message.data);
        sendResponse(sqlResult);
        break;

      case 'clear-model-cache':
        await clearModelCache();
        sendResponse({ status: 'cleared' });
        break;

      case 'export-db':
        const exportResult = await exportDatabase();
        sendResponse(exportResult);
        break;

      case 'import-db':
        const importResult = await importDatabase(message.data);
        sendResponse(importResult);
        break;

      // Messages intended for background: ignore to reduce noise
      case 'capturedContent':
        sendResponse({ ignored: true });
        break;

      case 'update-summary':
        try {
          const up = await db.updateSummaryByUrl(message.data?.url, message.data?.summary);
          sendResponse(up);
        } catch (e) {
          sendResponse({ error: e.message });
        }
        break;

      case 'ping':
        sendResponse({
          status: 'ok',
          initialized: isInitialized,
          initializing: isInitializing
        });
        break;

      case 'refresh-ai-prefs':
        await refreshAiPrefs();
        // If remote warm is enabled, attempt warm-up in background
        if (aiPrefs.enableRemoteWarm) {
          try { startRemoteWarm(); } catch {}
        }
        sendResponse({ status: 'ok', aiPrefs });
        break;

      case 'reload-embeddings':
        try {
          await refreshAiPrefs();
          await initializeEmbeddings();
          if (aiPrefs.enableRemoteWarm) {
            try { startRemoteWarm(); } catch {}
          }
          sendResponse({ status: 'reloaded' });
        } catch (e) {
          sendResponse({ error: e.message });
        }
        break;

      case 'get-model-status':
        sendResponse({ status: 'ok', modelStatus });
        break;

      case 'start-remote-warm':
        try {
          startRemoteWarm();
          sendResponse({ status: 'ok' });
        } catch (e) {
          sendResponse({ error: e.message });
        }
        break;

      case 'get-summary-queue-stats':
        try {
          const stats = await getSummaryQueueStats();
          sendResponse({ status: 'ok', stats });
        } catch (e) {
          sendResponse({ error: e.message });
        }
        break;

      case 'process-summary-queue':
        try {
          processSummaryQueue();
          sendResponse({ status: 'ok', message: 'Summary queue processing started' });
        } catch (e) {
          sendResponse({ error: e.message });
        }
        break;

      case 'clear-summary-queue':
        try {
          await clearSummaryQueue();
          sendResponse({ status: 'ok', message: 'Summary queue cleared' });
        } catch (e) {
          sendResponse({ error: e.message });
        }
        break;

      case 'save-chat-message':
        try {
          const { threadId = 'default', role, content } = message.data;
          const messageId = await db.saveChatMessage(threadId, role, content);

          // Auto-prune to keep only last 200 messages
          await db.pruneChatMessages(threadId, 200);

          sendResponse({ messageId, success: true });
        } catch (error) {
          sendResponse({ error: error.message });
        }
        break;

      case 'get-chat-messages':
        try {
          const { threadId = 'default', limit = 48 } = message.data || {};
          const messages = await db.getChatMessages(threadId, limit);
          sendResponse({ messages });
        } catch (error) {
          sendResponse({ error: error.message });
        }
        break;

      case 'clear-chat-thread':
        try {
          const { threadId = 'default' } = message.data || {};
          const deletedCount = await db.clearChatThread(threadId);
          sendResponse({ deletedCount, success: true });
        } catch (error) {
          sendResponse({ error: error.message });
        }
        break;

      case 'get-chat-thread-stats':
        try {
          const stats = await db.getChatThreadStats();
          sendResponse({ stats });
        } catch (error) {
          sendResponse({ error: error.message });
        }
        break;

      case 'deduplicate-chat-messages':
        try {
          const { threadId = 'default' } = message.data || {};
          const removedCount = await db.deduplicateChatMessages(threadId);
          sendResponse({ removedCount, success: true });
        } catch (error) {
          sendResponse({ error: error.message });
        }
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

  // If already initializing, return the existing promise
  if (isInitializing && initializationPromise) {
    return initializationPromise;
  }

  isInitializing = true;
  initializationPromise = performInitialization();

  try {
    await initializationPromise;
  } finally {
    isInitializing = false;
    initializationPromise = null;
  }
}

async function performInitialization() {
  try {
    console.log('[OFFSCREEN] Starting initialization...');

    // Initialize PGlite database
    await initializeDatabase();

    // Load AI preferences from storage
    await refreshAiPrefs();

    // Initialize embedding model
    await initializeEmbeddings();
    if (aiPrefs.enableRemoteWarm) {
      try { startRemoteWarm(); } catch {}
    }

    isInitialized = true;
    console.log('[OFFSCREEN] Initialization completed successfully');
  } catch (error) {
    console.error('[OFFSCREEN] Initialization failed:', error);
    isInitialized = false;
    throw error;
  }
}

async function refreshAiPrefs() {
  try {
    const stored = await chrome.storage.local.get(['aiPrefs']);
    if (stored && stored.aiPrefs && typeof stored.aiPrefs === 'object') {
      aiPrefs = {
        enableReranker: !!stored.aiPrefs.enableReranker,
        enableRemoteWarm: !!stored.aiPrefs.enableRemoteWarm
      };
    }
  } catch (e) {
    logger.debug('[OFFSCREEN] Failed to load aiPrefs; using defaults');
  }
}

// Database initialization
async function initializeDatabase() {
  try {
    logger.info('[DB] Initializing PGlite database with IndexedDB storage');

    // Import PGlite and vector extension
    const { PGlite } = await import(chrome.runtime.getURL('lib/pglite.js'));
    const { vector } = await import(chrome.runtime.getURL('lib/vector/index.js'));

    // Initialize PGlite with IndexedDB storage and vector extension
    const pglite = new PGlite({
      dataDir: 'idb://ai-history-pglite',
      extensions: {
        vector,
      }
      // Note: IndexedDB VFS is automatically selected when using 'idb://' dataDir
    });

    // Wait for database to be ready
    await pglite.waitReady;

    // Enable pgvector extension
    await pglite.exec('CREATE EXTENSION IF NOT EXISTS vector');

    logger.info('[DB] ✅ Using IndexedDB storage - safe for Chrome extension');

    // Create database wrapper with our API
    db = new DatabaseWrapper(pglite);

    // Initialize schema
    await db.initializeSchema();

    // Set up LISTEN/NOTIFY for queue notifications
    console.log('[QUEUE-NOTIFY] Setting up listener for summarization queue...');
    await db.db.listen('summarization_queue_channel', (payload) => {
      console.log(`[QUEUE-NOTIFY] Received notification: ${payload}`);
      if (payload === 'new_item' && !isProcessingSummaries) {
        console.log('[QUEUE-NOTIFY] Starting queue processing due to notification');
        processSummaryQueue();
      }
    });
    console.log('[QUEUE-NOTIFY] ✅ Queue listener registered successfully');

    logger.info('[DB] Database initialized successfully');

  } catch (error) {
    console.error('[DB] Failed to initialize PGlite:', error);
    throw new Error(`Database initialization failed: ${error.message}`);
  }
}

// Database wrapper class
class DatabaseWrapper {
  constructor(pglite) {
    this.db = pglite;
    this.initialized = true;
    this._vecSupport = true; // pgvector is always available
  }

  async updateSummaryByUrl(url, summary) {
    if (!url) return { error: 'Missing URL' };

    try {
      const result = await this.db.query('SELECT id FROM pages WHERE url = $1 LIMIT 1', [url]);
      if (result.rows.length === 0) {
        return { success: false, updated: 0 };
      }

      const id = result.rows[0].id;
      const normalized = typeof summary === 'string' ? summary : null;

      await this.db.query('UPDATE pages SET summary = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [normalized, id]);

      return { success: true, updated: 1, id };
    } catch (error) {
      console.error('[DB] Update summary failed:', error);
      return { error: error.message };
    }
  }

  async pageExists(url) {
    if (!url) return false;

    try {
      const result = await this.db.query('SELECT id FROM pages WHERE url = $1 LIMIT 1', [url]);
      return result.rows.length > 0;
    } catch (error) {
      console.error('[DB] Page exists check failed:', error);
      return false;
    }
  }

  async initializeSchema() {
    // Create main pages table with vector column
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        id SERIAL PRIMARY KEY,
        url TEXT UNIQUE NOT NULL,
        domain TEXT,
        title TEXT,
        content_text TEXT,
        summary TEXT,
        favicon_url TEXT,
        first_visit_at BIGINT,
        last_visit_at BIGINT,
        visit_count INTEGER DEFAULT 1,
        embedding vector(384),
        content_tsvector tsvector,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for efficient search
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pages_domain ON pages(domain);
      CREATE INDEX IF NOT EXISTS idx_pages_last_visit ON pages(last_visit_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pages_visit_count ON pages(visit_count DESC);
      CREATE INDEX IF NOT EXISTS idx_pages_url ON pages(url);
    `);

    // Vector similarity search index (IVFFlat for datasets)
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pages_embedding
        ON pages USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100);
    `);

    // Full-text search index
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pages_fts
        ON pages USING gin(content_tsvector);
    `);

    // Trigger to automatically update tsvector on insert/update
    await this.db.exec(`
      CREATE OR REPLACE FUNCTION update_content_tsvector()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.content_tsvector :=
          setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(NEW.domain, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(NEW.url, '')), 'B') ||
          setweight(to_tsvector('english', COALESCE(NEW.content_text, '')), 'C');
        NEW.updated_at := CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Drop trigger if exists and create new one (PostgreSQL doesn't support IF NOT EXISTS for triggers)
    await this.db.exec(`
      DROP TRIGGER IF EXISTS trig_update_content_tsvector ON pages;
      CREATE TRIGGER trig_update_content_tsvector
        BEFORE INSERT OR UPDATE ON pages
        FOR EACH ROW
        EXECUTE FUNCTION update_content_tsvector();
    `);

    // Create summarization queue table for database-backed queue
    console.log('[QUEUE-DB] Creating summarization queue table...');
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS summarization_queue (
        id SERIAL PRIMARY KEY,
        url TEXT UNIQUE NOT NULL,
        title TEXT,
        domain TEXT,
        content_text TEXT,
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP
      )
    `);

    // Create index for efficient queue processing
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_summarization_queue_status
      ON summarization_queue(status, created_at);
    `);
    console.log('[QUEUE-DB] ✅ Summarization queue table created successfully');

    // Create chat thread table
    console.log('[CHAT-DB] Creating chat thread table...');
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_thread (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create chat message table
    console.log('[CHAT-DB] Creating chat message table...');
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_message (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES chat_thread(id),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create chat message embedding table (optional for semantic recall)
    console.log('[CHAT-DB] Creating chat message embedding table...');
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_message_embedding (
        message_id TEXT PRIMARY KEY REFERENCES chat_message(id) ON DELETE CASCADE,
        embedding vector(384)
      )
    `);

    // Create indexes for chat tables
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chat_message_thread ON chat_message(thread_id);
      CREATE INDEX IF NOT EXISTS idx_chat_message_created ON chat_message(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_message_embedding_vec ON chat_message_embedding USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
    `);
    console.log('[CHAT-DB] ✅ Chat message tables created successfully');

    this._isVecTable = true;
  }

  async insert(table, data) {
    if (table === 'pages') {
      return this.insertPage(data);
    } else {
      throw new Error(`Unknown table: ${table}`);
    }
  }

  async insertPage(pageData) {
    // For pgvector, we need to provide a valid embedding or skip the row
    if (!pageData.embedding) {
      console.warn('[DB] Skipping page without embedding:', pageData.url);
      return { id: null };
    }

    // Check if this URL already exists to determine if it's a new page
    let isNewPage = false;
    try {
      const existingPage = await this.db.query('SELECT id FROM pages WHERE url = $1 LIMIT 1', [pageData.url]);
      isNewPage = existingPage.rows.length === 0;
    } catch (error) {
      console.warn('[DB] Failed to check existing page:', error);
      isNewPage = true; // Assume new if check fails
    }

    try {
      // Convert Float32Array to PostgreSQL array format
      const embeddingArray = `[${Array.from(pageData.embedding).join(',')}]`;
      const normalizedSummary = typeof pageData.summary === 'string' ? pageData.summary : null;

      // Use PostgreSQL UPSERT (INSERT ... ON CONFLICT)
      const result = await this.db.query(`
        INSERT INTO pages (
          url, domain, title, content_text, summary, favicon_url,
          first_visit_at, last_visit_at, visit_count, embedding
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector)
        ON CONFLICT (url) DO UPDATE SET
          title = EXCLUDED.title,
          content_text = EXCLUDED.content_text,
          summary = EXCLUDED.summary,
          domain = EXCLUDED.domain,
          favicon_url = EXCLUDED.favicon_url,
          last_visit_at = EXCLUDED.last_visit_at,
          visit_count = pages.visit_count + 1,
          embedding = EXCLUDED.embedding,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `, [
        pageData.url || '',
        pageData.domain || '',
        pageData.title || '',
        pageData.content_text || '',
        normalizedSummary,
        pageData.favicon_url || '',
        pageData.first_visit_at,
        pageData.last_visit_at,
        pageData.visit_count || 1,
        embeddingArray
      ]);

      const insertedId = result.rows[0]?.id;
      logger.debug(`[DB] Page ${isNewPage ? 'inserted' : 'updated'} successfully with ID: ${insertedId}`);

      return { id: insertedId, isNew: isNewPage };
    } catch (error) {
      console.error('[DB] Insert page failed:', error);
      throw error;
    }
  }


  async search(query, options = {}) {
    const { mode = 'hybrid-rerank', limit = 25, offset = 0 } = options;

    // perform search

    switch (mode) {
      case 'text':
        return this.textSearch(query, limit, offset);
      case 'vector':
        return this.vectorSearch(options.queryEmbedding, limit, offset);
      case 'hybrid-rrf':
      case 'hybrid-rerank':
        return this.hybridSearch(query, options.queryEmbedding, limit, offset, mode);
      default:
        throw new Error(`Unknown search mode: ${mode}`);
    }
  }

  async textSearch(query, limit, offset = 0) {
    try {
      // Escape special characters and prepare query
      const tsQuery = query.split(' ')
        .filter(term => term.length > 0)
        .map(term => `${term}:*`)
        .join(' & ');

      const result = await this.db.query(`
        SELECT
          id, url, domain, title, content_text, summary, favicon_url,
          first_visit_at, last_visit_at, visit_count,
          ts_rank_cd(content_tsvector, query) AS text_rank_score,
          ts_rank_cd(content_tsvector, query) AS score,
          ts_headline('english', content_text, query, 'MaxWords=32, MinWords=1, StartSel=<mark>, StopSel=</mark>') AS snippet
        FROM pages,
             plainto_tsquery('english', $1) AS query
        WHERE content_tsvector @@ query
          AND url NOT LIKE 'chrome://%'
          AND url NOT LIKE 'chrome-extension://%'
          AND url NOT LIKE 'moz-extension://%'
          AND url NOT LIKE 'edge://%'
          AND url NOT LIKE 'about:%'
          AND url NOT LIKE 'file://%'
          AND url NOT LIKE 'data:%'
          AND url NOT LIKE 'blob:%'
          AND url NOT LIKE 'javascript:%'
        ORDER BY text_rank_score DESC, last_visit_at DESC
        LIMIT $2 OFFSET $3
      `, [query, limit, offset]);

      return result.rows;
    } catch (error) {
      console.error('[DB] Text search failed:', error);
      // Fallback to ILIKE search
      try {
        const result = await this.db.query(`
          SELECT
            id, url, domain, title, content_text, summary, favicon_url,
            first_visit_at, last_visit_at, visit_count,
            0.5 AS text_rank_score,
            content_text AS snippet
          FROM pages
          WHERE (title ILIKE $1 OR content_text ILIKE $1)
            AND url NOT LIKE 'chrome://%'
            AND url NOT LIKE 'chrome-extension://%'
            AND url NOT LIKE 'moz-extension://%'
            AND url NOT LIKE 'edge://%'
            AND url NOT LIKE 'about:%'
            AND url NOT LIKE 'file://%'
            AND url NOT LIKE 'data:%'
            AND url NOT LIKE 'blob:%'
            AND url NOT LIKE 'javascript:%'
          ORDER BY last_visit_at DESC
          LIMIT $2 OFFSET $3
        `, [`%${query}%`, limit, offset]);

        return result.rows;
      } catch (fallbackError) {
        console.error('[DB] Fallback text search failed:', fallbackError);
        return [];
      }
    }
  }

  hasVecSupport() { return true; }

  async vectorSearch(queryEmbedding, limit, offset = 0) {
    if (!queryEmbedding) {
      throw new Error('Query embedding required for vector search');
    }

    try {
      // Convert Float32Array to PostgreSQL array format
      const embeddingArray = `[${Array.from(queryEmbedding).join(',')}]`;

      const result = await this.db.query(`
        SELECT
          id, url, domain, title, content_text, summary, favicon_url,
          first_visit_at, last_visit_at, visit_count,
          1 - (embedding <=> $1::vector) AS similarity,
          1 - (embedding <=> $1::vector) AS score,
          embedding <=> $1::vector AS distance
        FROM pages
        WHERE embedding IS NOT NULL
          AND url NOT LIKE 'chrome://%'
          AND url NOT LIKE 'chrome-extension://%'
          AND url NOT LIKE 'moz-extension://%'
          AND url NOT LIKE 'edge://%'
          AND url NOT LIKE 'about:%'
          AND url NOT LIKE 'file://%'
          AND url NOT LIKE 'data:%'
          AND url NOT LIKE 'blob:%'
          AND url NOT LIKE 'javascript:%'
        ORDER BY embedding <=> $1::vector
        LIMIT $2 OFFSET $3
      `, [embeddingArray, limit, offset]);

      return result.rows;
    } catch (error) {
      console.error('[DB] Vector search failed:', error);
      return [];
    }
  }

  async hybridSearch(query, queryEmbedding, limit, offset, mode) {
    // Get candidates from both search methods
    const needed = Math.min(offset + limit, 200);
    const candidateSize = Math.min(needed * 6, 300); // Increased candidate pool for better recall
    const [textResults, vectorResults] = await Promise.all([
      this.textSearch(query, candidateSize, 0),
      this.vectorSearch(queryEmbedding, candidateSize, 0)
    ]);

    if (mode === 'hybrid-rrf') {
      const fused = this.reciprocalRankFusion(textResults, vectorResults, needed);
      return fused.slice(offset, offset + limit);
    } else {
      const candidates = this.reciprocalRankFusion(textResults, vectorResults, needed * 2);
      const reranked = this.rerankCandidates(candidates, query, textResults, vectorResults, needed);
      return reranked.slice(offset, offset + limit);
    }
  }

  reciprocalRankFusion(textResults, vectorResults, limit, alpha = 0.4, k = 60) {
    const scores = new Map();
    const docMap = new Map();

    // Vector contribution (weighted by alpha)
    vectorResults.forEach((doc, index) => {
      const rrfScore = alpha / (k + index + 1);
      scores.set(doc.id, (scores.get(doc.id) || 0) + rrfScore);
      docMap.set(doc.id, doc);
    });

    // Text contribution (weighted by 1-alpha)
    textResults.forEach((doc, index) => {
      const rrfScore = (1 - alpha) / (k + index + 1);
      scores.set(doc.id, (scores.get(doc.id) || 0) + rrfScore);
      docMap.set(doc.id, doc);
    });

    // Sort by RRF score and return documents
    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, rrfScore]) => ({
        ...docMap.get(id),
        score: rrfScore, // Main score for UI display
        rrfScore // Keep original for debug
      }));
  }

  rerankCandidates(candidates, query, textResults, vectorResults, needCount) {
    // Normalized weighted hybrid: cosine (via distance), ts_rank text score, recency, visits
    const now = Date.now();

    // Build maps for quick lookup
    const vecDistMap = new Map();
    const textRankMap = new Map();
    const visitVals = [];

    vectorResults.forEach(d => { if (d.id != null && typeof d.distance === 'number') vecDistMap.set(d.id, d.distance); });
    textResults.forEach(d => { if (d.id != null && typeof d.text_rank_score === 'number') textRankMap.set(d.id, d.text_rank_score); });

    const vecVals = Array.from(vecDistMap.values());
    const textRankVals = Array.from(textRankMap.values());

    // Helper to get percentile value from array
    const getPercentile = (arr, p) => {
      if (!arr.length) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
      return sorted[idx];
    };

    // Create normalizer using percentile-based scaling with min/max fallback
    const mkNorm = (vals, smallerIsBetter) => {
      if (!vals.length) return { norm: () => 0 };

      // Try percentile normalization first
      const p5 = getPercentile(vals, 0.05);
      const p95 = getPercentile(vals, 0.95);
      let range = p95 - p5;

      // Fallback to min/max if percentiles are too close
      let usePercentile = range > 1e-9;
      if (!usePercentile) {
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        range = Math.max(1e-9, max - min);
        return {
          norm: (v) => {
            const x = (v - min) / range; // 0..1
            return smallerIsBetter ? 1 - x : x;
          }
        };
      }

      return {
        norm: (v) => {
          const x = Math.max(0, Math.min(1, (v - p5) / range)); // clamp to [0,1]
          return smallerIsBetter ? 1 - x : x;
        }
      };
    };

    const vecN = mkNorm(vecVals, true);
    const textRankN = mkNorm(textRankVals, false);

    candidates.forEach(d => visitVals.push(Number(d.visit_count) || 0));
    const maxVisits = Math.max(1, ...visitVals);

    // Scoring weights: optimized for personal browsing history
    const wVec = 0.3, wTextRank = 0.4, wRec = 0.2, wVis = 0.1;
    // Additional boosts: title=0.15, domain=0.1, url=0.08

    const scored = candidates.map(doc => {
      const vDist = vecDistMap.get(doc.id);
      const vScore = (typeof vDist === 'number') ? vecN.norm(vDist) : 0;

      const textRank = textRankMap.get(doc.id);
      const tScore = (typeof textRank === 'number') ? textRankN.norm(textRank) : 0;

      const days = (now - (doc.last_visit_at || now)) / (1000 * 60 * 60 * 24);
      const rec = Math.exp(-Math.log(2) * days / 14);

      const vc = Number(doc.visit_count) || 0;
      const vis = Math.log(vc + 1) / Math.log(maxVisits + 1);

      const titleBoost = doc.title && String(doc.title).toLowerCase().includes(String(query).toLowerCase()) ? 0.15 : 0;
      const domainBoost = doc.domain && String(doc.domain).toLowerCase().includes(String(query).toLowerCase()) ? 0.1 : 0;
      const urlBoost = doc.url && String(doc.url).toLowerCase().includes(String(query).toLowerCase()) ? 0.08 : 0;

      const boosts = Math.min(titleBoost + domainBoost + urlBoost, 0.25);
      const base = (wVec * vScore) + (wTextRank * tScore) + (wRec * rec) + (wVis * vis) + boosts;
      const finalScore = base > 0 ? (0.95 * base + 0.05 * (doc.rrfScore || 0)) : (doc.rrfScore || 0);

      return {
        ...doc,
        score: finalScore, // Main score for UI display
        finalScore, // Keep original for debug
        vScore,
        tScore,
        recency: rec,
        visitsNorm: vis,
        titleBoost,
        domainBoost,
        urlBoost
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, needCount);

    return scored;
  }

  // Enhanced search with keyword filtering
  async searchWithKeywords(query, keywords, options = {}) {
    // If no keywords provided, fall back to regular search
    if (!keywords) {
      return await this.search(query, options);
    }

    const {
      mode = 'hybrid-rerank',
      limit = 25,
      queryEmbedding
    } = options;

    logger.debug('[DB] Searching with keywords:', keywords);

    // Build enhanced query with keyword filters
    let textQuery = query;
    let vectorQuery = query;

    // Use keywords for search enhancement
    if (keywords.keywords && keywords.keywords.length > 0) {
      const keywordTerms = keywords.keywords.join(' ');
      textQuery = `${query} ${keywordTerms}`;
      vectorQuery = `${query} ${keywordTerms}`;
    }

    // Use the enhanced queries for search
    const results = await this.search(vectorQuery, {
      mode,
      limit: limit * 2, // Get more results for filtering
      queryEmbedding
    });

    // Apply keyword boosting
    const boostedResults = results.map(result => {
      let boostScore = 0;

      // Boost for keyword matches in title/content
      if (keywords.keywords && keywords.keywords.length > 0) {
        const content = [result.title || '', result.content_text || ''].join(' ').toLowerCase();
        const matchCount = keywords.keywords.filter(keyword =>
          content.includes(keyword.toLowerCase())
        ).length;
        boostScore += (matchCount / keywords.keywords.length) * 0.1;
      }


      return {
        ...result,
        finalScore: (result.finalScore || result.score || 0) + boostScore,
        keywordBoost: boostScore
      };
    });

    // Re-sort and limit results
    return boostedResults
      .sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0))
      .slice(0, limit);
  }

  // This method is no longer needed with PGlite as it returns proper objects
  // Keeping for compatibility but it's essentially a pass-through now
  rowToObject(row, columnNames = null) {
    return row;
  }

  async stats() {
    try {
      const result = await this.db.query(`
        SELECT
          COUNT(*) as page_count,
          COUNT(embedding) as embedding_count
        FROM pages
      `);

      const stats = result.rows[0];
      return {
        pageCount: parseInt(stats.page_count),
        embeddingCount: parseInt(stats.embedding_count),
        hasVecSupport: this.hasVecSupport()
      };
    } catch (error) {
      console.error('[DB] Stats query failed:', error);
      return {
        pageCount: 0,
        embeddingCount: 0,
        hasVecSupport: this.hasVecSupport()
      };
    }
  }

  async clear() {
    // Clear all tables
    try {
      await this.db.exec('TRUNCATE TABLE pages RESTART IDENTITY CASCADE');
      await this.db.exec('VACUUM');
    } catch (error) {
      console.error('[DB] Clear database failed:', error);
      // Fallback to DELETE if TRUNCATE fails
      try {
        await this.db.exec('DELETE FROM pages');
        await this.db.exec('VACUUM');
      } catch (fallbackError) {
        console.error('[DB] Fallback clear failed:', fallbackError);
        throw fallbackError;
      }
    }
  }

  // Chat message management functions
  async ensureChatThread(threadId = 'default') {
    try {
      await this.db.query('INSERT INTO chat_thread (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [threadId]);
      return threadId;
    } catch (error) {
      console.error('[DB] Failed to ensure chat thread:', error);
      throw error;
    }
  }

  async saveChatMessage(threadId, role, content) {
    try {
      await this.ensureChatThread(threadId);

      // Check for recent duplicate messages (within last 60 seconds with same content)
      const duplicateCheck = await this.db.query(`
        SELECT id FROM chat_message
        WHERE thread_id = $1
          AND role = $2
          AND content = $3
          AND created_at > NOW() - INTERVAL '60 seconds'
        LIMIT 1
      `, [threadId, role, content]);

      if (duplicateCheck.rows.length > 0) {
        logger.debug('[DB] Duplicate message detected, skipping save:', duplicateCheck.rows[0].id);
        return duplicateCheck.rows[0].id;
      }

      const messageId = `${threadId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      logger.debug('[DB] Saving new chat message:', messageId, 'role:', role, 'content length:', content.length);

      await this.db.query(`
        INSERT INTO chat_message (id, thread_id, role, content)
        VALUES ($1, $2, $3, $4)
      `, [messageId, threadId, role, content]);

      return messageId;
    } catch (error) {
      console.error('[DB] Failed to save chat message:', error);
      throw error;
    }
  }

  async getChatMessages(threadId = 'default', limit = 200) {
    try {
      const result = await this.db.query(`
        SELECT id, role, content, created_at
        FROM chat_message
        WHERE thread_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `, [threadId, limit]);

      // Return in chronological order (oldest first)
      return result.rows.reverse();
    } catch (error) {
      console.error('[DB] Failed to get chat messages:', error);
      return [];
    }
  }

  async pruneChatMessages(threadId = 'default', keepCount = 200) {
    try {
      const result = await this.db.query(`
        DELETE FROM chat_message
        WHERE thread_id = $1
          AND id IN (
            SELECT id FROM chat_message
            WHERE thread_id = $1
            ORDER BY created_at ASC
            OFFSET $2
          )
      `, [threadId, keepCount]);

      return result.rowCount || 0;
    } catch (error) {
      console.error('[DB] Failed to prune chat messages:', error);
      return 0;
    }
  }

  async clearChatThread(threadId = 'default') {
    try {
      const result = await this.db.query('DELETE FROM chat_message WHERE thread_id = $1', [threadId]);
      return result.rowCount || 0;
    } catch (error) {
      console.error('[DB] Failed to clear chat thread:', error);
      return 0;
    }
  }

  async deduplicateChatMessages(threadId = 'default') {
    try {
      // Remove duplicate messages keeping only the earliest one for each content+role combination
      const result = await this.db.query(`
        DELETE FROM chat_message
        WHERE id NOT IN (
          SELECT MIN(id)
          FROM chat_message
          WHERE thread_id = $1
          GROUP BY role, content
        )
        AND thread_id = $1
      `, [threadId]);

      logger.debug('[DB] Removed', result.rowCount || 0, 'duplicate messages');
      return result.rowCount || 0;
    } catch (error) {
      console.error('[DB] Failed to deduplicate chat messages:', error);
      return 0;
    }
  }

  async getChatThreadStats() {
    try {
      const result = await this.db.query(`
        SELECT
          COUNT(*) as total_messages,
          COUNT(DISTINCT thread_id) as thread_count,
          MAX(created_at) as latest_message
        FROM chat_message
      `);

      return result.rows[0] || { total_messages: 0, thread_count: 0, latest_message: null };
    } catch (error) {
      console.error('[DB] Failed to get chat thread stats:', error);
      return { total_messages: 0, thread_count: 0, latest_message: null };
    }
  }
}

// Embeddings initialization
async function initializeEmbeddings() {
  // Initialize embedding model (Transformers.js), local-first
  const mod = await import(chrome.runtime.getURL('lib/transformers.min.js'));
  const env = mod.env;
  // Configure ONNX runtime for MV3 extension constraints
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.simd = false;
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('lib/');
  if (typeof env.allowLocalModels !== 'undefined') env.allowLocalModels = true;
  if (typeof env.allowRemoteModels !== 'undefined') env.allowRemoteModels = false; // default: local only
  if (typeof env.localModelPath !== 'undefined') env.localModelPath = chrome.runtime.getURL('lib/models/');
  // Avoid using Cache API with chrome-extension:// URLs to prevent errors; enable only during remote warm
  if (typeof env.useBrowserCache !== 'undefined') env.useBrowserCache = false;

  const { pipeline } = mod;
  // Start with the bundled small quantized model
  const LOCAL_SMALL = 'Xenova/bge-small-en-v1.5-quantized';
  embedder = await pipeline('feature-extraction', LOCAL_SMALL);

  embedModel = {
    initialized: true,
    async embed(text) {
      const str = typeof text === 'string' ? text : String(text || '');
      const out = await embedder(str, { pooling: 'mean', normalize: true });
      const data = out?.data || out; // transformers.js returns tensor-like
      return data instanceof Float32Array ? data : new Float32Array(data);
    }
  };
  modelStatus = { using: 'local', warming: false, lastError: null };
}

// Page ingestion
async function ingestPage(pageInfo) {
  try {
    // Use extracted content if available, otherwise fallback
    const content = pageInfo.extractedContent ? {
      title: pageInfo.extractedContent.title || pageInfo.title || 'Untitled',
      text: pageInfo.extractedContent.text || '',
      summary: pageInfo.extractedContent.summary || null
    } : {
      title: pageInfo.title || 'Untitled',
      text: '',
      summary: null
    };

    // Prepare summary - queue for later processing if needed
    let summary = content.summary;
    if (!summary) {
      summary = buildFallbackSummary(content.text, content.title, pageInfo.url);
      // Queue for AI summarization if content is substantial
      if (content.text && content.text.trim().length > 100) {
        // Queue asynchronously without blocking ingestion
        queueForSummarization(pageInfo.url, {
          text: content.text,
          title: content.title,
          url: pageInfo.url,
          domain: new URL(pageInfo.url).hostname
        }).catch(error => {
          console.error(`[SUMMARIZATION] Failed to queue item: ${pageInfo.url}`, error);
        });
      }
    }

    // Generate embedding for content (always create one for sqlite-vec compatibility)
    // Include title, domain, and content for better semantic matching
    const domain = new URL(pageInfo.url).hostname;
    const textToEmbed = content.title + ' ' + domain + ' ' + content.text;
    const embedding = textToEmbed.trim().length > 0 ? await embed(textToEmbed) : await embed('webpage');

    // Ensure summary is a string for vec0 metadata
    if (summary == null) summary = '';

    // Store in database
    const pageResult = await db.insert('pages', {
      url: pageInfo.url,
      title: content.title,
      content_text: content.text,
      summary: summary,
      domain: domain,
      first_visit_at: Math.floor(pageInfo.visitTime || Date.now()),
      last_visit_at: Math.floor(pageInfo.visitTime || Date.now()),
      visit_count: 1,
      embedding: embedding
    });

    // Notify UI if this is a new page (not just an update)
    if (pageResult.isNew) {
      try {
        await chrome.runtime.sendMessage({
          type: 'content_indexed',
          data: {
            url: pageInfo.url,
            title: content.title,
            domain: domain,
            isNew: true,
            timestamp: Date.now(),
            indexingComplete: true
          }
        });
        console.log(`[INGESTION] ✅ Notified UI of new content: ${pageInfo.url}`);
      } catch (error) {
        console.debug('[INGESTION] Failed to notify UI (normal if no listeners):', error.message);
      }
    }

    return { status: 'success', pageId: pageResult.id };
  } catch (error) {
    console.error('[OFFSCREEN] Failed to ingest page:', error);
    return { error: error.message };
  }
}

// Ingest captured content directly
async function ingestCapturedContent(capturedData) {

  try {
    // Generate summary - queue for later processing if needed
    let summary = capturedData.summary;
    if (!summary) {
      summary = buildFallbackSummary(capturedData.text || '', capturedData.title || '', capturedData.url);
      // Queue for AI summarization if content is substantial
      if (capturedData.text && capturedData.text.trim().length > 100) {
        // Queue asynchronously without blocking ingestion
        queueForSummarization(capturedData.url, {
          text: capturedData.text,
          title: capturedData.title,
          url: capturedData.url,
          domain: capturedData.domain
        }).catch(error => {
          console.error(`[SUMMARIZATION] Failed to queue captured item: ${capturedData.url}`, error);
        });
      }
    }

    // Generate embedding
    // Include title, domain, and content for better semantic matching
    const domain = capturedData.domain || extractDomain(capturedData.url);
    const textToEmbed = (capturedData.title || '') + ' ' + domain + ' ' + (capturedData.text || '');
    const embedding = await embed(textToEmbed);

    // Ensure summary is a string for vec0 metadata
    if (summary == null) summary = '';

    // Store in database
    const pageResult = await db.insert('pages', {
      url: capturedData.url,
      title: capturedData.title,
      content_text: capturedData.text,
      summary: summary,
      domain: capturedData.domain,
      first_visit_at: Math.floor(capturedData.timestamp || Date.now()),
      last_visit_at: Math.floor(capturedData.timestamp || Date.now()),
      visit_count: 1,
      embedding: embedding
    });

    // Notify UI if this is a new page (including browser-only pages being indexed)
    if (pageResult.isNew) {
      try {
        await chrome.runtime.sendMessage({
          type: 'content_indexed',
          data: {
            url: capturedData.url,
            title: capturedData.title,
            domain: capturedData.domain,
            isNew: true,
            timestamp: Date.now(),
            source: 'captured',
            indexingComplete: true
          }
        });
        console.log(`[INGESTION] ✅ Notified UI of captured content: ${capturedData.url}`);
      } catch (error) {
        console.debug('[INGESTION] Failed to notify UI (normal if no listeners):', error.message);
      }
    }

    return { status: 'success', pageId: pageResult.id, source: 'captured' };
  } catch (error) {
    console.error('[OFFSCREEN] Failed to ingest captured content:', error);
    return { error: error.message };
  }
}

// Offscreen summarization (best-effort, no user gesture required)
async function trySummarizeOffscreen(text, url, title) {
  try {
    // Avoid trivial inputs
    if (!text || text.trim().length < 100) return null;

    // Prefer new API
    if (globalThis?.ai?.summarizer) {
      try {
        const caps = await globalThis.ai.summarizer.capabilities();
        if (caps?.available !== 'readily') {
          return null;
        }
      } catch (_) {
        // capabilities may not exist on some builds; proceed guarded
      }

      const s = await globalThis.ai.summarizer.create({
        type: 'tldr',
        length: 'long',
        format: 'plain-text',
        language: 'en',
        outputLanguage: 'en'
      });
      try {
        const MAX = 8000;
        let input = text.length > MAX ? text.slice(0, MAX) + '...' : text;
        try {
          const summary = await s.summarize(input, {
            context: `Web page titled "${title || ''}" from ${safeHost(url)}`,
            language: 'en',
            outputLanguage: 'en'
          });
          if (typeof summary === 'string' && summary.trim()) {
            return summary;
          }
        } catch (e) {
          if ((e?.name === 'QuotaExceededError' || /too\s+large/i.test(e?.message)) && input.length > 4000) {
            input = text.slice(0, 4000) + '...';
            const summary = await s.summarize(input, {
              context: `Web page titled "${title || ''}" from ${safeHost(url)}`,
              language: 'en',
              outputLanguage: 'en'
            });
            if (typeof summary === 'string' && summary.trim()) {
              return summary;
            }
          }
        }
      } finally {
        try { await s?.destroy?.(); } catch {}
      }
    }

    // Legacy Chrome AI API fallback for older Chrome versions - maintained for compatibility
    if (globalThis?.Summarizer) {
      try {
        const summarizer = await globalThis.Summarizer.create({
          type: 'tldr', length: 'long', format: 'plain-text', language: 'en', outputLanguage: 'en'
        });
        try {
          const MAX = 8000;
          const input = text.length > MAX ? text.slice(0, MAX) + '...' : text;
          const summary = await summarizer.summarize(input, {
            context: `Web page titled "${title || ''}" from ${safeHost(url)}`,
            language: 'en', outputLanguage: 'en'
          });
          if (typeof summary === 'string' && summary.trim()) {
            return summary;
          }
        } finally {
          try { summarizer?.destroy?.(); } catch {}
        }
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[OFFSCREEN] trySummarizeOffscreen failed:', e?.message || e);
    // ignore errors; return null
  }
  return null;
}

function safeHost(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}

function buildFallbackSummary(text, title = '', url = '') {
  try {
    const host = safeHost(url);
    if (text && typeof text === 'string' && text.trim().length > 0) {
      // Take first ~3 sentences or ~300 chars, whichever comes first
      const cleaned = text.replace(/\s+/g, ' ').trim();
      const sentences = cleaned.split(/(?<=[.!?])\s+/).slice(0, 3).join(' ');
      let snippet = (sentences && sentences.trim().length > 0) ? sentences : cleaned.slice(0, 300);
      if (snippet.length > 400) snippet = snippet.slice(0, 400) + '…';
      return snippet;
    }
    // Fall back to a structured summary using title/host
    const t = (title || '').trim();
    if (t) return t;
    if (host) return `Visited ${host}`;
    if (url) return url;
    return '';
  } catch {
    return null;
  }
}

// Ingest all items from captured content queue
async function ingestCapturedQueue() {
  // Process captured content queue

  try {
    // Request captured queue from background
    const response = await chrome.runtime.sendMessage({ type: 'getCapturedQueue' });

    if (!response.success) {
      throw new Error(response.error || 'Failed to get captured queue');
    }

    const capturedMap = response.map || {};
    const urls = Object.keys(capturedMap);

    if (urls.length === 0) {
      return { status: 'success', processed: 0 };
    }

    // Process items

    let processed = 0;
    const processedUrls = [];

    for (const url of urls) {
      const capturedData = capturedMap[url];

      try {
        const result = await ingestCapturedContent(capturedData);
        if (result.status === 'success') {
          processed++;
          processedUrls.push(url);
        }
      } catch (error) {
        console.error('[OFFSCREEN] Failed to process captured item:', url, error);
      }
    }

    // Delete processed entries from background storage
    if (processedUrls.length > 0) {
      await chrome.runtime.sendMessage({
        type: 'deleteCapturedEntries',
        urls: processedUrls
      });
    }

    return { status: 'success', processed, total: urls.length };
  } catch (error) {
    console.error('[OFFSCREEN] Failed to process captured queue:', error);
    return { error: error.message };
  }
}

// Helper function to get combined history for empty queries
async function getCombinedHistory({ limit = 25, offset = 0 }) {
  try {
    // Get browser history from last 90 days
    const browserResponse = await getBrowserHistory({ query: '', limit: 1000 });
    const browserResults = browserResponse.results || [];
    console.log('[OFFSCREEN] Browser history results:', browserResults.length, browserResults.slice(0, 3));

    // Get all PGlite data (no search, just recent entries)
    // For empty queries, we need to get all pages sorted by last visit
    const pgliteResults = await db.db.query(`
      SELECT
        id, url, domain, title, content_text, summary, favicon_url,
        first_visit_at, last_visit_at, visit_count,
        NULL as score,
        COALESCE(substring(content_text from 1 for 200), title) as snippet
      FROM pages
      WHERE url NOT LIKE 'chrome://%'
        AND url NOT LIKE 'chrome-extension://%'
        AND url NOT LIKE 'moz-extension://%'
        AND url NOT LIKE 'edge://%'
        AND url NOT LIKE 'about:%'
        AND url NOT LIKE 'file://%'
        AND url NOT LIKE 'data:%'
        AND url NOT LIKE 'blob:%'
        AND url NOT LIKE 'javascript:%'
      ORDER BY last_visit_at DESC
      LIMIT 1000
    `);

    // Convert to expected format
    const formattedPgliteResults = pgliteResults.rows || [];
    console.log('[OFFSCREEN] PGlite results:', formattedPgliteResults.length, formattedPgliteResults.slice(0, 2));

    // Merge results
    const mergedResults = mergeHistoryResults(formattedPgliteResults, browserResults);
    console.log('[OFFSCREEN] Merged results:', mergedResults.length, mergedResults.slice(0, 2));

    // Apply pagination
    const startIndex = offset;
    const endIndex = startIndex + limit;
    const paginatedResults = mergedResults.slice(startIndex, endIndex);

    return { results: paginatedResults };
  } catch (error) {
    console.error('[OFFSCREEN] getCombinedHistory failed:', error);
    // Fallback to just browser history
    try {
      const browserResponse = await getBrowserHistory({ query: '', limit });
      return { results: browserResponse.results || [] };
    } catch (fallbackError) {
      return { error: fallbackError.message };
    }
  }
}

// Helper function to merge and deduplicate results from PGlite and browser history
function mergeHistoryResults(pgliteResults, browserResults) {
  // Create a map keyed by URL for deduplication
  const resultMap = new Map();

  // Add PGlite results first (they have priority with AI summaries)
  if (Array.isArray(pgliteResults)) {
    pgliteResults.forEach(result => {
      if (result.url) {
        resultMap.set(result.url, {
          ...result,
          source: 'pglite',
          hasAiSummary: !!(result.summary || result.content_text)
        });
      }
    });
  }

  // Add browser history results, but don't overwrite PGlite data
  if (Array.isArray(browserResults)) {
    browserResults.forEach(result => {
      if (result.url && !resultMap.has(result.url)) {
        resultMap.set(result.url, {
          id: null,
          url: result.url,
          title: result.title || 'Untitled',
          domain: extractDomain(result.url),
          content_text: null,
          summary: null,
          favicon_url: null,
          first_visit_at: result.lastVisitTime || Date.now(),
          last_visit_at: result.lastVisitTime || Date.now(),
          visit_count: result.visitCount || 1,
          source: 'browser',
          hasAiSummary: false,
          score: null
        });
      }
    });
  }

  // Convert map to array and sort appropriately
  const mergedArray = Array.from(resultMap.values());

  // Check if results have scores from search
  const hasScores = mergedArray.some(item =>
    item.score !== undefined && item.score !== null
  );

  if (hasScores) {
    // Sort by score descending for search results
    mergedArray.sort((a, b) => {
      const scoreA = a.score || a.finalScore || a.rrfScore || 0;
      const scoreB = b.score || b.finalScore || b.rrfScore || 0;
      return scoreB - scoreA;
    });
  } else {
    // Sort by last visit time for browsing (empty query)
    mergedArray.sort((a, b) => {
      const timeA = a.last_visit_at || 0;
      const timeB = b.last_visit_at || 0;
      return timeB - timeA; // Descending order (newest first)
    });
  }

  return mergedArray;
}

// Helper function to extract domain from URL
function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// Browser history integration
async function getBrowserHistory({ query = '', limit = 1000 } = {}) {
  try {
    // Request browser history via background script (since offscreen can't access chrome.history directly)
    console.log('[OFFSCREEN] Requesting browser history from background...');
    const response = await chrome.runtime.sendMessage({
      type: 'get-chrome-history',
      data: { query, limit }
    });

    console.log('[OFFSCREEN] Browser history response:', response);

    if (response.error) {
      throw new Error(response.error);
    }

    return { results: response.results || [] };
  } catch (error) {
    console.error('[OFFSCREEN] Browser history fetch failed:', error);
    return { error: error.message };
  }
}

async function getBrowserHistoryWithKeywords({ query = '', keywords, limit = 1000 } = {}) {
  try {
    // Get regular browser history first
    const historyResponse = await getBrowserHistory({ query, limit });

    if (historyResponse.error || !historyResponse.results) {
      return historyResponse;
    }

    let results = historyResponse.results;

    // Apply keyword filtering if provided
    if (keywords) {
      console.log('[OFFSCREEN] Applying keyword filters to browser history:', keywords);

      // Boost results with keyword matches
      results = results.map(item => {
        let boostScore = 0;
        const content = [item.title || '', item.url || ''].join(' ').toLowerCase();

        // Boost for general keywords
        if (keywords.keywords && keywords.keywords.length > 0) {
          const matchCount = keywords.keywords.filter(keyword =>
            content.includes(keyword.toLowerCase())
          ).length;
          boostScore += (matchCount / keywords.keywords.length) * 0.1;
        }

        return {
          ...item,
          keywordBoost: boostScore,
          finalScore: boostScore // Browser history doesn't have existing scores
        };
      });

      // Sort by keyword relevance if we have boosts
      if (keywords.keywords?.length > 0) {
        results.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));
      }
    }

    return { results };
  } catch (error) {
    console.error('[OFFSCREEN] Browser history with keywords fetch failed:', error);
    return { error: error.message };
  }
}

// Search implementation with browser history integration
async function search({ query, keywords, mode = 'hybrid-rerank', limit = 25, offset = 0 }) {
  try {
    // For empty queries, return combined browser history + PGlite data
    if (!query || query.trim().length === 0) {
      return await getCombinedHistory({ limit, offset });
    }

    logger.debug('[SEARCH] Query:', query);
    if (keywords) {
      logger.debug('[SEARCH] Extracted keywords:', keywords);
    }

    // For search queries, get results from both sources
    const [pgliteResponse, browserResponse] = await Promise.allSettled([
      // PGlite search with embeddings and keyword filtering
      (async () => {
        const queryEmbedding = await embed(query);
        return await db.searchWithKeywords(query, keywords, {
          mode,
          limit: Math.ceil(limit * 1.5), // Get more results for merging
          offset: 0, // Always start from beginning for merging
          queryEmbedding
        });
      })(),
      // Browser history search with keyword filtering
      getBrowserHistoryWithKeywords({ query, keywords, limit: Math.ceil(limit * 1.5) })
    ]);

    const pgliteResults = pgliteResponse.status === 'fulfilled' ? pgliteResponse.value : [];
    const browserResults = browserResponse.status === 'fulfilled' ? browserResponse.value.results || [] : [];

    // Merge and deduplicate results
    const mergedResults = mergeHistoryResults(pgliteResults, browserResults);

    // Apply pagination
    const startIndex = offset;
    const endIndex = startIndex + limit;
    const paginatedResults = mergedResults.slice(startIndex, endIndex);

    return { results: paginatedResults };
  } catch (error) {
    console.error('[OFFSCREEN] Search failed:', error);
    return { error: error.message };
  }
}

// Remote warm-up: prefetch larger remote model and hot-swap when ready
async function warmRemoteModel() {
  const { pipeline, env } = await import(chrome.runtime.getURL('lib/transformers.min.js'));
  const REMOTE_MODEL = 'Xenova/bge-small-en-v1.5'; // 384-dim output; compatible with vec0 schema

  const prevCache = env.useBrowserCache;
  const prevRemote = env.allowRemoteModels;
  const prevLocal = env.allowLocalModels;
  try {
    env.allowRemoteModels = true;
    env.allowLocalModels = false; // force remote resolution for the warm model
    env.useBrowserCache = true; // enable Cache API for https fetches
    modelStatus.warming = true;
    modelStatus.lastError = null;

    const warm = await pipeline('feature-extraction', REMOTE_MODEL);

    // Optionally verify output dim ~384 by running a tiny embedding
    try {
      const testOut = await warm('warmup test', { pooling: 'mean', normalize: true });
      const dim = (testOut?.data || testOut)?.length || 0;
      if (dim && dim !== 384) {
        throw new Error(`Incompatible embedding dimension: ${dim}`);
      }
    } catch (e) {
      throw e;
    }

    // Hot-swap
    embedder = warm;
    embedModel = {
      initialized: true,
      async embed(text) {
        const str = typeof text === 'string' ? text : String(text || '');
        const out = await embedder(str, { pooling: 'mean', normalize: true });
        const data = out?.data || out;
        return data instanceof Float32Array ? data : new Float32Array(data);
      }
    };
    modelStatus.using = 'remote';
  } catch (e) {
    modelStatus.lastError = String(e?.message || e);
  } finally {
    modelStatus.warming = false;
    // Restore cache policy for extension URLs
    env.useBrowserCache = prevCache;
    env.allowRemoteModels = prevRemote;
    env.allowLocalModels = prevLocal;
  }
}

function startRemoteWarm() {
  if (modelStatus.using === 'remote' || modelStatus.warming) return;
  try { void warmRemoteModel(); } catch {}
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
  // Clear database
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

// Utility functions for debug page
async function executeSQL({ query, writeMode = false }) {
  // Execute SQL

  if (!db || !db.db) {
    return { error: 'Database not initialized' };
  }

  try {
    // Basic safety check for write operations
    const isWriteQuery = /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\s+/i.test(query.trim());
    if (isWriteQuery && !writeMode) {
      return { error: 'Write operations require write mode to be enabled' };
    }

    // Use PGlite query method
    const result = await db.db.query(query);

    return {
      success: true,
      results: result.rows || [],
      rowCount: result.rows ? result.rows.length : result.affectedRows || 0,
      query: query
    };
  } catch (error) {
    console.error('[OFFSCREEN] SQL execution failed:', error, 'Query:', query);
    return { error: error.message, query: query };
  }
}

async function clearModelCache() {
  // Clear model cache

  try {
    // Reset embedding model
    embedModel = null;
    embedder = null;

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    // Model cache cleared
  } catch (error) {
    console.error('[OFFSCREEN] Failed to clear model cache:', error);
    throw error;
  }
}

async function exportDatabase() {
  try {
    if (!db) {
      throw new Error('Database not initialized');
    }

    const stats = await db.stats();
    return {
      success: true,
      stats,
      timestamp: Date.now(),
      message: 'Database export shows stats only (full export not implemented)'
    };
  } catch (error) {
    console.error('[OFFSCREEN] Database export failed:', error);
    return { error: error.message };
  }
}

async function importDatabase(data) {
  return {
    success: false,
    error: 'Database import not implemented'
  };
}

// Summarization queue functions
async function queueForSummarization(url, data) {
  console.log(`[SUMMARIZATION] Queueing page for summarization: ${url}`);
  console.table({ url, title: data.title, domain: data.domain, contentLength: data.text?.length || 0 });

  try {
    // Insert into database queue (ON CONFLICT DO NOTHING prevents duplicates)
    console.log(`[QUEUE-DB] Adding item to database queue: ${url}`);
    const result = await db.db.query(`
      INSERT INTO summarization_queue (url, title, domain, content_text)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (url) DO NOTHING
      RETURNING id
    `, [url, data.title || '', data.domain || '', data.text || '']);

    if (result.rows.length > 0) {
      console.log(`[QUEUE-DB] ✅ Item added to queue with ID: ${result.rows[0].id}`);

      // Notify listeners that a new item was added
      await db.db.query("NOTIFY summarization_queue_channel, 'new_item'");
      console.log(`[QUEUE-NOTIFY] Notification sent for new queue item: ${url}`);
    } else {
      console.log(`[QUEUE-DB] Item already exists in queue: ${url}`);
    }
  } catch (error) {
    console.error(`[QUEUE-DB] Failed to add item to queue: ${url}`, error);
  }
}

async function getSummaryQueueStats() {
  try {
    // Get real-time stats from database
    const result = await db.db.query(`
      SELECT
        status,
        COUNT(*) as count
      FROM summarization_queue
      GROUP BY status
      UNION ALL
      SELECT 'total' as status, COUNT(*) as count
      FROM summarization_queue
    `);

    const statsMap = {};
    result.rows.forEach(row => {
      statsMap[row.status] = parseInt(row.count);
    });

    const stats = {
      queued: statsMap.pending || 0,
      processing: statsMap.processing || 0,
      completed: statsMap.completed || 0,
      failed: statsMap.failed || 0,
      total: statsMap.total || 0,
      queueLength: statsMap.pending || 0, // Legacy compatibility
      isProcessing: isProcessingSummaries,
      currentlyProcessing: summaryQueueStats.currentlyProcessing
    };

    return stats;
  } catch (error) {
    console.error('[QUEUE-DB] Failed to get queue stats:', error);
    // Return fallback stats
    return {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      total: 0,
      queueLength: 0,
      isProcessing: isProcessingSummaries,
      currentlyProcessing: summaryQueueStats.currentlyProcessing
    };
  }
}

async function clearSummaryQueue() {
  try {
    // Get current queue stats for logging
    const currentStats = await getSummaryQueueStats();
    console.log(`[QUEUE-DB] Clearing queue with ${currentStats.total} items`);

    // Clear the database table
    await db.db.query('TRUNCATE TABLE summarization_queue RESTART IDENTITY');
    console.log('[QUEUE-DB] ✅ Queue cleared successfully');

    // Reset in-memory stats
    summaryQueueStats = {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      currentlyProcessing: null
    };
  } catch (error) {
    console.error('[QUEUE-DB] Failed to clear queue:', error);
    throw error;
  }
}

async function processSummaryQueue() {
  if (isProcessingSummaries) {
    console.log('[SUMMARIZATION] Queue processing already in progress');
    return;
  }

  // Check for pending items in database
  let pendingItems;
  try {
    const result = await db.db.query(`
      SELECT id, url, title, domain, content_text, attempts, max_attempts
      FROM summarization_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
    `);
    pendingItems = result.rows || [];
  } catch (error) {
    console.error('[QUEUE-DB] Failed to query pending items:', error);
    return;
  }

  if (pendingItems.length === 0) {
    console.log('[SUMMARIZATION] No items in queue to process');
    return;
  }

  isProcessingSummaries = true;
  console.log(`[SUMMARIZATION] Starting queue processing. ${pendingItems.length} items to process`);
  console.group('📝 Summarization Queue Processing');

  for (const item of pendingItems) {
    // Update item status to processing
    try {
      await db.db.query(`
        UPDATE summarization_queue
        SET status = 'processing', attempts = attempts + 1
        WHERE id = $1
      `, [item.id]);
    } catch (error) {
      console.error(`[QUEUE-DB] Failed to update item status: ${item.url}`, error);
      continue;
    }

    summaryQueueStats.currentlyProcessing = {
      url: item.url,
      title: item.title || 'Untitled',
      domain: item.domain || '',
      attempt: item.attempts + 1,
      maxAttempts: item.max_attempts
    };

    console.log(`[SUMMARIZATION] Processing: ${item.url} (attempt ${item.attempts + 1}/${item.max_attempts})`);

    try {
      summaryQueueStats.processing++;

      // Try to generate AI summary
      const aiSummary = await trySummarizeOffscreen(
        item.content_text,
        item.url,
        item.title
      );

      if (aiSummary && typeof aiSummary === 'string' && aiSummary.trim().length > 0) {
        // Update database with the AI-generated summary
        const updateResult = await db.updateSummaryByUrl(item.url, aiSummary);

        if (updateResult && updateResult.success) {
          console.log(`[SUMMARIZATION] ✅ Successfully updated summary for: ${item.url}`);
          summaryQueueStats.completed++;

          // Mark item as completed in queue
          await db.db.query(`
            UPDATE summarization_queue
            SET status = 'completed', processed_at = CURRENT_TIMESTAMP
            WHERE id = $1
          `, [item.id]);

          // Notify UI of summary completion for better user experience
          try {
            await chrome.runtime.sendMessage({
              type: 'content_summary_updated',
              data: {
                url: item.url,
                title: item.title,
                domain: item.domain,
                timestamp: Date.now()
              }
            });
          } catch (error) {
            console.debug('[SUMMARIZATION] Failed to notify UI (normal if no listeners):', error.message);
          }
        } else {
          console.warn(`[SUMMARIZATION] ⚠️ Failed to update database for: ${item.url}`, updateResult);
          // Mark as failed
          await db.db.query(`
            UPDATE summarization_queue
            SET status = 'failed', processed_at = CURRENT_TIMESTAMP
            WHERE id = $1
          `, [item.id]);
          summaryQueueStats.failed++;
        }
      } else {
        // AI summarization failed, but don't retry - fallback summary already exists
        console.log(`[SUMMARIZATION] ℹ️ AI summarization unavailable for: ${item.url}, keeping fallback summary`);
        // Mark as failed
        await db.db.query(`
          UPDATE summarization_queue
          SET status = 'failed', processed_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [item.id]);
        summaryQueueStats.failed++;
      }

    } catch (error) {
      console.error(`[SUMMARIZATION] ❌ Error processing ${item.url}:`, error);

      const newAttempts = item.attempts + 1;
      if (newAttempts < item.max_attempts) {
        console.log(`[SUMMARIZATION] 🔄 Will retry ${item.url} (attempt ${newAttempts + 1}/${item.max_attempts})`);
        // Reset status to pending for retry
        await db.db.query(`
          UPDATE summarization_queue
          SET status = 'pending'
          WHERE id = $1
        `, [item.id]);
      } else {
        console.error(`[SUMMARIZATION] 💀 Max attempts reached for: ${item.url}`);
        // Mark as failed
        await db.db.query(`
          UPDATE summarization_queue
          SET status = 'failed', processed_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [item.id]);
        summaryQueueStats.failed++;
      }
    }

    summaryQueueStats.currentlyProcessing = null;

    // Add a small delay between processing items to avoid overwhelming the AI API
    const remainingItems = await db.db.query(`
      SELECT COUNT(*) as count FROM summarization_queue WHERE status = 'pending'
    `);
    const remainingCount = remainingItems.rows[0]?.count || 0;

    if (remainingCount > 0) {
      console.log(`[SUMMARIZATION] Waiting 2s before next item... (${remainingCount} remaining)`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  isProcessingSummaries = false;

  console.log(`[SUMMARIZATION] ✅ Queue processing completed. Stats:`, {
    completed: summaryQueueStats.completed,
    failed: summaryQueueStats.failed
  });
  console.groupEnd();
}

// Initialize on load
initialize().catch(error => {
  console.error('[OFFSCREEN] Failed to initialize:', error);
});

console.log('[QUEUE-NOTIFY] Queue processing now uses LISTEN/NOTIFY - no polling required');
