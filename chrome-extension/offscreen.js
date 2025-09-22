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

  try {
    // Prepare sqlite3 config to suppress harmless OPFS warning during init
    // This warning appears when running on the main thread where Atomics.wait isn't allowed.
    // We use IndexedDB VFS, so it's expected and safe to ignore.
    globalThis.sqlite3ApiConfig = Object.assign({}, globalThis.sqlite3ApiConfig, {
      warn: (...args) => {
        const message = args.join(' ');
        if (message.includes('Ignoring inability to install OPFS sqlite3_vfs')) {
          return; // suppress benign OPFS warning
        }
        console.warn('[SQLITE]', ...args);
      }
    });

    // Import sqlite3 module
    const sqlite3InitModule = (await import(chrome.runtime.getURL('lib/sqlite3.mjs'))).default;

    console.log('[DB] Loading SQLite WASM...');
    const sqlite3 = await sqlite3InitModule({
      print: (...args) => console.log('[SQLITE]', ...args),
      printErr: (...args) => {
        // Filter out harmless OPFS warning since we use IndexedDB VFS
        const message = args.join(' ');
        if (message.includes('Ignoring inability to install OPFS sqlite3_vfs')) {
          return;
        }
        console.error('[SQLITE]', ...args);
      },
    });

    console.log('[DB] SQLite WASM loaded, version:', sqlite3.version.libVersion);

    // Use IndexedDB VFS (default)
    const dbPath = '/ai-history.db';
    console.log('[DB] Opening IndexedDB database:', dbPath);
    const sqliteDb = new sqlite3.oo1.DB(dbPath, 'c');

    // Create database wrapper with our API
    db = new DatabaseWrapper(sqliteDb, sqlite3);

    // Initialize schema
    await db.initializeSchema();

  } catch (error) {
    console.error('[DB] Failed to initialize SQLite:', error);
    throw new Error(`Database initialization failed: ${error.message}`);
  }
}

// Database wrapper class
class DatabaseWrapper {
  constructor(sqliteDb, sqlite3) {
    this.db = sqliteDb;
    this.sqlite3 = sqlite3;
    this.initialized = true;
    this._vecSupport = null; // Cache vec support detection
  }

  async initializeSchema() {
    // Create main pages table using sqlite-vec virtual table (combined approach)
    let usingVecTable = false;
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS pages USING vec0(
          id INTEGER PRIMARY KEY,
          url TEXT,
          domain TEXT,
          title TEXT,
          content_text TEXT,
          summary TEXT,
          favicon_url TEXT,
          first_visit_at INTEGER,
          last_visit_at INTEGER,
          visit_count INTEGER,
          embedding FLOAT[384]
        )
      `);
      console.log('[DB] sqlite-vec pages table created successfully');
      usingVecTable = true;
    } catch (vecError) {
      console.warn('[DB] sqlite-vec not available, falling back to regular table:', vecError);
      // Fallback to regular table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url TEXT UNIQUE NOT NULL,
          domain TEXT NOT NULL,
          title TEXT,
          content_text TEXT,
          summary TEXT,
          favicon_url TEXT,
          first_visit_at INTEGER NOT NULL,
          last_visit_at INTEGER NOT NULL,
          visit_count INTEGER NOT NULL DEFAULT 1
        )
      `);

      // Separate embeddings table for fallback
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS page_embeddings (
          id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
          embedding BLOB NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      usingVecTable = false;
    }

    // Store the table type for later use
    this._isVecTable = usingVecTable;

    // Create FTS5 virtual table for full-text search
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
          id UNINDEXED,
          title,
          content_text
        )
      `);
      console.log('[DB] FTS5 table created successfully');
    } catch (ftsError) {
      console.warn('[DB] FTS5 not available, search will use fallback methods:', ftsError);
    }

    // Create indexes only for regular tables (not virtual tables)
    if (!usingVecTable) {
      try {
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_pages_domain ON pages(domain);
          CREATE INDEX IF NOT EXISTS idx_pages_last_visit ON pages(last_visit_at);
          CREATE INDEX IF NOT EXISTS idx_pages_visit_count ON pages(visit_count);
          CREATE INDEX IF NOT EXISTS idx_embeddings_updated ON page_embeddings(updated_at);
        `);
        console.log('[DB] Created indexes for regular tables');
      } catch (indexError) {
        console.warn('[DB] Could not create indexes:', indexError);
      }
    }

    console.log('[DB] Database schema created successfully');
  }

  async insert(table, data) {
    if (table === 'pages') {
      return this.insertPage(data);
    } else {
      throw new Error(`Unknown table: ${table}`);
    }
  }

  async insertPage(pageData) {
    if (this.hasVecSupport()) {
      // For vec0 tables, we need to provide a valid embedding or skip the row
      if (!pageData.embedding) {
        console.warn('[DB] Skipping page without embedding for vec0 table:', pageData.url);
        return { id: null };
      }

      // Insert into vec0 table (includes embedding)
      const stmt = this.db.prepare(`
        INSERT INTO pages (url, domain, title, content_text, summary, favicon_url, first_visit_at, last_visit_at, visit_count, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      try {
        const embeddingJson = JSON.stringify(Array.from(pageData.embedding));

        stmt.bind([
          pageData.url || '',
          pageData.domain || '',
          pageData.title || '',
          pageData.content_text || '',
          pageData.summary || '',
          pageData.favicon_url || '',
          pageData.first_visit_at,
          pageData.last_visit_at,
          pageData.visit_count,
          embeddingJson
        ]);
        stmt.step();
        stmt.finalize();

        // Get the inserted row ID
        const insertedId = this.db.selectValue('SELECT last_insert_rowid()');

        // Manually synchronize with FTS5 table
        try {
          const ftsStmt = this.db.prepare(`
            INSERT INTO pages_fts (id, title, content_text)
            VALUES (?, ?, ?)
          `);
          ftsStmt.bind([insertedId, pageData.title, pageData.content_text]);
          ftsStmt.step();
          ftsStmt.finalize();
        } catch (ftsError) {
          console.warn('[DB] FTS5 update failed:', ftsError);
        }

        return { id: insertedId };
      } catch (error) {
        stmt.finalize();
        throw error;
      }
    } else {
      // Fallback to regular table
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO pages
        (url, domain, title, content_text, summary, favicon_url, first_visit_at, last_visit_at, visit_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      try {
        const result = stmt.run(
          pageData.url,
          pageData.domain,
          pageData.title,
          pageData.content_text,
          pageData.summary || null,
          pageData.favicon_url || null,
          pageData.first_visit_at,
          pageData.last_visit_at,
          pageData.visit_count
        );

        // Update FTS5 table if available
        try {
          const ftsStmt = this.db.prepare(`
            INSERT OR REPLACE INTO pages_fts(rowid, title, content_text)
            VALUES (?, ?, ?)
          `);
          ftsStmt.run(result.lastInsertRowid, pageData.title, pageData.content_text);
          ftsStmt.finalize();
        } catch (ftsError) {
          console.warn('[DB] FTS5 update failed:', ftsError);
        }

        // Store embedding in separate table for fallback mode
        if (pageData.embedding) {
          try {
            const embStmt = this.db.prepare(`
              INSERT OR REPLACE INTO page_embeddings (id, embedding, updated_at)
              VALUES (?, ?, ?)
            `);
            const embeddingBlob = new Uint8Array(pageData.embedding.buffer);
            embStmt.run(result.lastInsertRowid, embeddingBlob, Date.now());
            embStmt.finalize();
          } catch (embError) {
            console.warn('[DB] Embedding storage failed:', embError);
          }
        }

        stmt.finalize();
        return { id: result.lastInsertRowid };
      } catch (error) {
        stmt.finalize();
        throw error;
      }
    }
  }


  async search(query, options = {}) {
    const { mode = 'hybrid-rerank', limit = 25 } = options;

    console.log(`[DB] Performing ${mode} search for:`, query);

    switch (mode) {
      case 'text':
        return this.textSearch(query, limit);
      case 'vector':
        return this.vectorSearch(options.queryEmbedding, limit);
      case 'hybrid-rrf':
      case 'hybrid-rerank':
        return this.hybridSearch(query, options.queryEmbedding, limit, mode);
      default:
        throw new Error(`Unknown search mode: ${mode}`);
    }
  }

  async textSearch(query, limit) {
    // Try FTS5 first, fallback to LIKE
    try {
      const stmt = this.db.prepare(`
        SELECT p.*, snippet(pages_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
        FROM pages_fts
        JOIN pages p ON p.id = pages_fts.id
        WHERE pages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `);

      const results = [];
      stmt.bind([query, limit]);
      while (stmt.step()) {
        results.push(this.rowToObject(stmt));
      }
      stmt.finalize();

      return results;
    } catch (ftsError) {
      console.warn('[DB] FTS5 search failed, using LIKE fallback:', ftsError);

      // Fallback to LIKE search
      const likeQuery = `%${query.toLowerCase()}%`;
      const stmt = this.db.prepare(`
        SELECT *, substr(content_text, 1, 200) as snippet
        FROM pages
        WHERE LOWER(title) LIKE ? OR LOWER(content_text) LIKE ?
        ORDER BY last_visit_at DESC
        LIMIT ?
      `);

      const results = [];
      stmt.bind([likeQuery, likeQuery, limit]);
      while (stmt.step()) {
        results.push(this.rowToObject(stmt));
      }
      stmt.finalize();

      return results;
    }
  }

  hasVecSupport() {
    // Use the flag set during schema initialization
    return this._isVecTable === true;
  }

  async vectorSearch(queryEmbedding, limit) {
    if (!queryEmbedding) {
      throw new Error('Query embedding required for vector search');
    }

    if (!this.hasVecSupport()) {
      console.warn('[DB] sqlite-vec not available, cannot perform vector search');
      return [];
    }

    try {
      const stmt = this.db.prepare(`
        SELECT id, url, domain, title, content_text, summary, favicon_url,
               first_visit_at, last_visit_at, visit_count, distance
        FROM pages
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `);

      const results = [];
      stmt.bind([JSON.stringify(Array.from(queryEmbedding)), limit]);

      while (stmt.step()) {
        results.push(this.rowToObject(stmt));
      }

      stmt.finalize();
      return results;
    } catch (error) {
      console.error('[DB] Vector search failed:', error);
      return [];
    }
  }

  async hybridSearch(query, queryEmbedding, limit, mode) {
    if (!this.hasVecSupport() || !queryEmbedding) {
      console.warn('[DB] Vector search not available, falling back to text search');
      return this.textSearch(query, limit);
    }

    try {
      // Get candidates from both search methods
      const candidateSize = Math.min(limit * 4, 100); // Get more candidates for fusion
      const [textResults, vectorResults] = await Promise.all([
        this.textSearch(query, candidateSize),
        this.vectorSearch(queryEmbedding, candidateSize)
      ]);

      if (mode === 'hybrid-rrf') {
        // Use RRF fusion only
        return this.reciprocalRankFusion(textResults, vectorResults, limit);
      } else {
        // hybrid-rerank: RRF + additional scoring
        const candidates = this.reciprocalRankFusion(textResults, vectorResults, limit * 2);
        return this.rerankCandidates(candidates, query, limit);
      }
    } catch (error) {
      console.error('[DB] Hybrid search failed, falling back to text search:', error);
      return this.textSearch(query, limit);
    }
  }

  reciprocalRankFusion(textResults, vectorResults, limit, alpha = 0.6, k = 60) {
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
        rrfScore
      }));
  }

  rerankCandidates(candidates, query, limit) {
    // Simple reranking based on additional features
    // This can be enhanced with cross-encoder models in future phases
    const now = Date.now();

    return candidates.map(doc => {
      let score = doc.rrfScore || 0;

      // Add recency boost (more recent = higher score)
      const daysSinceVisit = (now - doc.last_visit_at) / (1000 * 60 * 60 * 24);
      const recencyBoost = Math.exp(-daysSinceVisit / 30) * 0.1; // Decay over 30 days

      // Add popularity boost
      const popularityBoost = Math.log(doc.visit_count + 1) * 0.05;

      // Add title match boost
      const titleMatch = doc.title && doc.title.toLowerCase().includes(query.toLowerCase()) ? 0.2 : 0;

      const finalScore = score + recencyBoost + popularityBoost + titleMatch;

      return {
        ...doc,
        finalScore,
        recencyBoost,
        popularityBoost,
        titleMatch
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, limit);
  }

  rowToObject(stmt, columnNames = null) {
    if (!columnNames) {
      // If no column names provided, try to get them from the statement
      try {
        const obj = {};
        const colCount = stmt.getColumnCount();
        for (let i = 0; i < colCount; i++) {
          const name = stmt.getColumnName(i);
          obj[name] = stmt.get(i);
        }
        return obj;
      } catch (error) {
        // Fallback to basic object with indices
        console.warn('[DB] Could not get column names, using indices:', error);
        return {
          column_0: stmt.get(0),
          column_1: stmt.get(1),
          column_2: stmt.get(2),
          column_3: stmt.get(3),
          column_4: stmt.get(4),
          column_5: stmt.get(5)
        };
      }
    } else {
      // Use provided column names
      const obj = {};
      columnNames.forEach((name, i) => {
        obj[name] = stmt.get(i);
      });
      return obj;
    }
  }

  async stats() {
    const pageCountStmt = this.db.prepare('SELECT COUNT(*) as count FROM pages');
    pageCountStmt.step();
    const pageCount = pageCountStmt.get(0);
    pageCountStmt.finalize();

    let embeddingCount = 0;
    if (this.hasVecSupport()) {
      // For vec0 tables, count pages with non-null embeddings
      try {
        const embeddingCountStmt = this.db.prepare('SELECT COUNT(*) as count FROM pages WHERE embedding IS NOT NULL');
        embeddingCountStmt.step();
        embeddingCount = embeddingCountStmt.get(0);
        embeddingCountStmt.finalize();
      } catch (error) {
        console.warn('[DB] Could not get embedding count:', error);
      }
    } else {
      // For fallback, count from separate embeddings table
      try {
        const embeddingCountStmt = this.db.prepare('SELECT COUNT(*) as count FROM page_embeddings');
        embeddingCountStmt.step();
        embeddingCount = embeddingCountStmt.get(0);
        embeddingCountStmt.finalize();
      } catch (error) {
        console.warn('[DB] Could not get embedding count:', error);
      }
    }

    return {
      pageCount,
      embeddingCount,
      hasVecSupport: this.hasVecSupport(),
      storageType: this.hasVecSupport() ? 'sqlite-vec' : 'blob-fallback'
    };
  }

  async clear() {
    console.log('[DB] Clearing all tables...');
    try {
      this.db.exec('DELETE FROM pages_fts');
    } catch (error) {
      console.warn('[DB] Could not clear FTS table:', error);
    }

    if (!this.hasVecSupport()) {
      try {
        this.db.exec('DELETE FROM page_embeddings');
      } catch (error) {
        console.warn('[DB] Could not clear embeddings table:', error);
      }
    }

    this.db.exec('DELETE FROM pages');
    this.db.exec('VACUUM');
    console.log('[DB] Database cleared');
  }
}

// Embeddings initialization
async function initializeEmbeddings() {
  console.log('[ML] Initializing embedding model...');

  // TODO: Replace with actual Transformers.js implementation
  embedModel = {
    initialized: true,
    async embed(text) {
      // Mock 384-dimensional embedding for now
      return new Float32Array(384).fill(0).map(() => Math.random() - 0.5);
    }
  };

  console.log('[ML] Mock embedding model initialized');
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

    // Generate embedding for content (always create one for sqlite-vec compatibility)
    const textToEmbed = content.title + ' ' + content.text;
    const embedding = textToEmbed.trim().length > 0 ? await embed(textToEmbed) : await embed('webpage');

    // Store in database
    const pageId = await db.insert('pages', {
      url: pageInfo.url,
      title: content.title,
      content_text: content.text,
      summary: content.summary,
      domain: new URL(pageInfo.url).hostname,
      first_visit_at: pageInfo.visitTime || Date.now(),
      last_visit_at: pageInfo.visitTime || Date.now(),
      visit_count: 1,
      embedding: embedding
    });

    return { status: 'success', pageId: pageId.id };
  } catch (error) {
    console.error('[OFFSCREEN] Failed to ingest page:', error);
    return { error: error.message };
  }
}

// Ingest captured content directly
async function ingestCapturedContent(capturedData) {
  console.log('[OFFSCREEN] Ingesting captured content:', capturedData.url);

  try {
    // Generate embedding
    const textToEmbed = capturedData.title + ' ' + capturedData.text;
    const embedding = await embed(textToEmbed);

    // Store in database
    const pageId = await db.insert('pages', {
      url: capturedData.url,
      title: capturedData.title,
      content_text: capturedData.text,
      summary: capturedData.summary,
      domain: capturedData.domain,
      first_visit_at: capturedData.timestamp || Date.now(),
      last_visit_at: capturedData.timestamp || Date.now(),
      visit_count: 1,
      embedding: embedding
    });

    console.log('[OFFSCREEN] Successfully ingested captured content for:', capturedData.url);
    return { status: 'success', pageId: pageId.id, source: 'captured' };
  } catch (error) {
    console.error('[OFFSCREEN] Failed to ingest captured content:', error);
    return { error: error.message };
  }
}

// Ingest all items from captured content queue
async function ingestCapturedQueue() {
  console.log('[OFFSCREEN] Processing captured content queue...');

  try {
    // Request captured queue from background
    const response = await chrome.runtime.sendMessage({ type: 'getCapturedQueue' });

    if (!response.success) {
      throw new Error(response.error || 'Failed to get captured queue');
    }

    const capturedMap = response.map || {};
    const urls = Object.keys(capturedMap);

    if (urls.length === 0) {
      console.log('[OFFSCREEN] No captured content to process');
      return { status: 'success', processed: 0 };
    }

    console.log(`[OFFSCREEN] Processing ${urls.length} captured items...`);

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

    console.log(`[OFFSCREEN] Processed ${processed}/${urls.length} captured items`);
    return { status: 'success', processed, total: urls.length };
  } catch (error) {
    console.error('[OFFSCREEN] Failed to process captured queue:', error);
    return { error: error.message };
  }
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

// Utility functions for debug page
async function executeSQL({ query, writeMode = false }) {
  console.log('[OFFSCREEN] Executing SQL:', query);

  if (!db || !db.db) {
    return { error: 'Database not initialized' };
  }

  try {
    // Basic safety check for write operations
    const isWriteQuery = /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\s+/i.test(query.trim());
    if (isWriteQuery && !writeMode) {
      return { error: 'Write operations require write mode to be enabled' };
    }

    const results = [];

    // Use prepared statement approach like working prototype
    if (query.trim().toUpperCase().startsWith('SELECT')) {
      // For SELECT queries, use prepared statement
      const stmt = db.db.prepare(query);
      try {
        while (stmt.step()) {
          const row = stmt.get({});
          results.push(row);
        }
      } finally {
        stmt.finalize();
      }
    } else {
      // For non-SELECT queries, just execute
      db.db.exec(query);
    }

    return {
      success: true,
      results,
      rowCount: results.length,
      query: query
    };
  } catch (error) {
    console.error('[OFFSCREEN] SQL execution failed:', error, 'Query:', query);
    return { error: error.message, query: query };
  }
}

async function clearModelCache() {
  console.log('[OFFSCREEN] Clearing model cache...');

  try {
    // Reset embedding model
    embedModel = null;

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    console.log('[OFFSCREEN] Model cache cleared');
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

// Initialize on load
initialize().catch(error => {
  console.error('[OFFSCREEN] Failed to initialize:', error);
});
