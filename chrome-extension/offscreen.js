/**
 * AI-Powered Browser History - Offscreen Document
 * Handles SQLite database, embeddings, and heavy processing tasks
 */

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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

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
        sendResponse({ status: 'ok', initialized: isInitialized });
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
        sendResponse({ status: 'ok', stats: getSummaryQueueStats() });
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
        clearSummaryQueue();
        sendResponse({ status: 'ok', message: 'Summary queue cleared' });
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

  try {
    // Initialize SQLite database
    await initializeDatabase();

    // Load AI preferences from storage
    await refreshAiPrefs();

    // Initialize embedding model
    await initializeEmbeddings();
    if (aiPrefs.enableRemoteWarm) {
      try { startRemoteWarm(); } catch {}
    }

    isInitialized = true;
  } catch (error) {
    console.error('[OFFSCREEN] Initialization failed:', error);
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
    console.debug('[OFFSCREEN] Failed to load aiPrefs; using defaults');
  }
}

// Database initialization
async function initializeDatabase() {
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

    const sqlite3 = await sqlite3InitModule({
      print: () => {},
      printErr: (...args) => {
        // Filter out harmless OPFS warning since we use IndexedDB VFS
        const message = args.join(' ');
        if (message.includes('Ignoring inability to install OPFS sqlite3_vfs')) {
          return;
        }
        console.error('[SQLITE]', ...args);
      },
    });

    // Use IndexedDB VFS (default)
    const dbPath = '/ai-history.db';
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
    this._vecSupport = true; // Assume vec support is always available
  }

  updateSummaryByUrl(url, summary) {
    if (!url) return { error: 'Missing URL' };
    const sel = this.db.prepare('SELECT id FROM pages WHERE url = ? LIMIT 1');
    sel.bind([url]);
    let id = null;
    if (sel.step()) {
      id = sel.get(0);
    }
    sel.finalize();
    if (!id) return { success: false, updated: 0 };

    const isString = typeof summary === 'string';
    const normalized = isString ? summary : null;
    const upd = this.db.prepare('UPDATE pages SET summary = ? WHERE id = ?');
    upd.bind([normalized, id]);
    upd.step();
    upd.finalize();
    return { success: true, updated: 1, id };
  }

  async initializeSchema() {
    // Assume sqlite-vec and FTS5 are always available
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

    this._isVecTable = true;

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
        id UNINDEXED,
        title,
        content_text
      )
    `);
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

      // Check if URL exists and update instead of inserting a duplicate
      let existingId = null;
      let existingVisitCount = 0;
      let existingFirstVisit = null;
      try {
        const checkStmt = this.db.prepare('SELECT id, visit_count, first_visit_at FROM pages WHERE url = ? LIMIT 1');
        checkStmt.bind([pageData.url]);
        if (checkStmt.step()) {
          existingId = checkStmt.get(0);
          existingVisitCount = Number(checkStmt.get(1)) || 0;
          existingFirstVisit = Number(checkStmt.get(2)) || pageData.first_visit_at;
        }
        checkStmt.finalize();
      } catch (e) {
        console.warn('[DB] Upsert check failed (vec0):', e);
      }

      const embeddingJson = JSON.stringify(Array.from(pageData.embedding));

      if (existingId) {
        const upd = this.db.prepare(`
          UPDATE pages
          SET domain = ?, title = ?, content_text = ?, summary = ?, favicon_url = ?,
              last_visit_at = ?, visit_count = ?, embedding = ?
          WHERE id = ?
        `);
        try {
          const newVisit = existingVisitCount + 1;
          // vec0 expects TEXT metadata columns to be TEXT, not NULL
          const normalizedSummary = (typeof pageData.summary === 'string') ? pageData.summary : '';
          upd.bind([
            pageData.domain || '',
            pageData.title || '',
            pageData.content_text || '',
            normalizedSummary,
            pageData.favicon_url || '',
            pageData.last_visit_at,
            newVisit,
            embeddingJson,
            existingId
          ]);
          upd.step();
          upd.finalize();

          // Sync FTS5
          try {
            const ftsUpd = this.db.prepare(`
              INSERT OR REPLACE INTO pages_fts (id, title, content_text)
              VALUES (?, ?, ?)
            `);
            ftsUpd.bind([existingId, pageData.title, pageData.content_text]);
            ftsUpd.step();
            ftsUpd.finalize();
          } catch (ftsError) {
            console.warn('[DB] FTS5 update failed (update):', ftsError);
          }

          return { id: existingId };
        } catch (error) {
          upd.finalize();
          throw error;
        }
      } else {
        // Insert new
        const stmt = this.db.prepare(`
          INSERT INTO pages (url, domain, title, content_text, summary, favicon_url, first_visit_at, last_visit_at, visit_count, embedding)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        try {
          // vec0 expects TEXT, not NULL, for metadata columns like summary
          const normalizedSummary = (typeof pageData.summary === 'string') ? pageData.summary : '';
          stmt.bind([
            pageData.url || '',
            pageData.domain || '',
            pageData.title || '',
            pageData.content_text || '',
            normalizedSummary,
            pageData.favicon_url || '',
            pageData.first_visit_at,
            pageData.last_visit_at,
            pageData.visit_count,
            embeddingJson
          ]);
          stmt.step();
          stmt.finalize();

          const insertedId = this.db.selectValue('SELECT last_insert_rowid()');

          // Sync FTS5
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
      }
    } else {
      // Unreachable: vec support is assumed always available
      throw new Error('vec0 support required');
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
    // Assume FTS5 is available; use bm25
    const colNames = ['id','url','domain','title','content_text','summary','favicon_url','first_visit_at','last_visit_at','visit_count','bm25_score','snippet'];
    const stmt = this.db.prepare(`
      SELECT 
        p.id, p.url, p.domain, p.title, p.content_text, p.summary, p.favicon_url,
        p.first_visit_at, p.last_visit_at, p.visit_count,
        bm25(pages_fts) AS bm25_score,
        snippet(pages_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
      FROM pages_fts
      JOIN pages p ON p.id = pages_fts.id
      WHERE pages_fts MATCH ?
      ORDER BY bm25_score
      LIMIT ? OFFSET ?
    `);

    const results = [];
    stmt.bind([query, limit, offset]);
    while (stmt.step()) {
      results.push(this.rowToObject(stmt, colNames));
    }
    stmt.finalize();

    return results;
  }

  hasVecSupport() { return true; }

  async vectorSearch(queryEmbedding, limit, offset = 0) {
    if (!queryEmbedding) {
      throw new Error('Query embedding required for vector search');
    }

    const colNames = ['id','url','domain','title','content_text','summary','favicon_url','first_visit_at','last_visit_at','visit_count','distance'];
    const stmt = this.db.prepare(`
      SELECT id, url, domain, title, content_text, summary, favicon_url,
             first_visit_at, last_visit_at, visit_count, distance
      FROM pages
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ? OFFSET ?
    `);

    const results = [];
    stmt.bind([JSON.stringify(Array.from(queryEmbedding)), limit, offset]);
    while (stmt.step()) {
      results.push(this.rowToObject(stmt, colNames));
    }
    stmt.finalize();
    return results;
  }

  async hybridSearch(query, queryEmbedding, limit, offset, mode) {
    // Get candidates from both search methods
    const needed = Math.min(offset + limit, 200);
    const candidateSize = Math.min(needed * 4, 200);
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

  rerankCandidates(candidates, query, textResults, vectorResults, needCount) {
    // Normalized weighted hybrid: cosine (via distance), BM25, recency, visits
    const now = Date.now();

    // Build maps for quick lookup
    const vecDistMap = new Map();
    const bm25Map = new Map();
    const visitVals = [];

    vectorResults.forEach(d => { if (d.id != null && typeof d.distance === 'number') vecDistMap.set(d.id, d.distance); });
    textResults.forEach(d => { if (d.id != null && typeof d.bm25_score === 'number') bm25Map.set(d.id, d.bm25_score); });

    const vecVals = Array.from(vecDistMap.values());
    const bmVals = Array.from(bm25Map.values());

    const mkNorm = (vals, smallerIsBetter) => {
      if (!vals.length) return { norm: () => 0 };
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const range = Math.max(1e-9, max - min);
      return {
        norm: (v) => {
          const x = (v - min) / range; // 0..1
          return smallerIsBetter ? 1 - x : x;
        }
      };
    };

    const vecN = mkNorm(vecVals, true);
    const bmN = mkNorm(bmVals, true);

    candidates.forEach(d => visitVals.push(Number(d.visit_count) || 0));
    const maxVisits = Math.max(1, ...visitVals);

    const wVec = 0.5, wBm25 = 0.3, wRec = 0.1, wVis = 0.1;

    const scored = candidates.map(doc => {
      const vDist = vecDistMap.get(doc.id);
      const vScore = (typeof vDist === 'number') ? vecN.norm(vDist) : 0;

      const bm = bm25Map.get(doc.id);
      const tScore = (typeof bm === 'number') ? bmN.norm(bm) : 0;

      const days = (now - (doc.last_visit_at || now)) / (1000 * 60 * 60 * 24);
      const rec = Math.exp(-days / 30);

      const vc = Number(doc.visit_count) || 0;
      const vis = Math.log(vc + 1) / Math.log(maxVisits + 1);

      const titleBoost = doc.title && String(doc.title).toLowerCase().includes(String(query).toLowerCase()) ? 0.05 : 0;

      const base = (wVec * vScore) + (wBm25 * tScore) + (wRec * rec) + (wVis * vis) + titleBoost;
      const finalScore = base > 0 ? base : (doc.rrfScore || 0);

      return { ...doc, finalScore, vScore, tScore, recency: rec, visitsNorm: vis };
    })
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, needCount);

    return scored;
  }

  rowToObject(stmt, columnNames = null) {
    if (!columnNames) {
      // If no column names provided, try to get them from the statement
      try {
        const obj = {};
        const names = typeof stmt.getColumnNames === 'function'
          ? stmt.getColumnNames([])
          : (() => {
              const n = (typeof stmt.columnCount === 'number') ? stmt.columnCount : 0;
              const arr = [];
              for (let i = 0; i < n; i++) arr.push(stmt.getColumnName(i));
              return arr;
            })();
        for (let i = 0; i < names.length; i++) {
          obj[names[i]] = stmt.get(i);
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
    // For vec0 tables, count pages with non-null embeddings
    try {
      const embeddingCountStmt = this.db.prepare('SELECT COUNT(*) as count FROM pages WHERE embedding IS NOT NULL');
      embeddingCountStmt.step();
      embeddingCount = embeddingCountStmt.get(0);
      embeddingCountStmt.finalize();
    } catch (error) {
      console.warn('[DB] Could not get embedding count:', error);
    }

    return {
      pageCount,
      embeddingCount,
      hasVecSupport: this.hasVecSupport()
    };
  }

  async clear() {
    // Clear all tables
    try {
      this.db.exec('DELETE FROM pages_fts');
    } catch (error) {
      console.warn('[DB] Could not clear FTS table:', error);
    }

    this.db.exec('DELETE FROM pages');
    this.db.exec('VACUUM');
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
        queueForSummarization(pageInfo.url, {
          text: content.text,
          title: content.title,
          url: pageInfo.url,
          domain: new URL(pageInfo.url).hostname
        });
      }
    }

    // Generate embedding for content (always create one for sqlite-vec compatibility)
    const textToEmbed = content.title + ' ' + content.text;
    const embedding = textToEmbed.trim().length > 0 ? await embed(textToEmbed) : await embed('webpage');

    // Ensure summary is a string for vec0 metadata
    if (summary == null) summary = '';

    // Store in database
    const pageId = await db.insert('pages', {
      url: pageInfo.url,
      title: content.title,
      content_text: content.text,
      summary: summary,
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

  try {
    // Generate summary - queue for later processing if needed
    let summary = capturedData.summary;
    if (!summary) {
      summary = buildFallbackSummary(capturedData.text || '', capturedData.title || '', capturedData.url);
      // Queue for AI summarization if content is substantial
      if (capturedData.text && capturedData.text.trim().length > 100) {
        queueForSummarization(capturedData.url, {
          text: capturedData.text,
          title: capturedData.title,
          url: capturedData.url,
          domain: capturedData.domain
        });
      }
    }

    // Generate embedding
    const textToEmbed = (capturedData.title || '') + ' ' + (capturedData.text || '');
    const embedding = await embed(textToEmbed);

    // Ensure summary is a string for vec0 metadata
    if (summary == null) summary = '';

    // Store in database
    const pageId = await db.insert('pages', {
      url: capturedData.url,
      title: capturedData.title,
      content_text: capturedData.text,
      summary: summary,
      domain: capturedData.domain,
      first_visit_at: capturedData.timestamp || Date.now(),
      last_visit_at: capturedData.timestamp || Date.now(),
      visit_count: 1,
      embedding: embedding
    });

    return { status: 'success', pageId: pageId.id, source: 'captured' };
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

    // TODO(ai-canary): Legacy API fallback (prototype) — revisit and remove if no longer needed
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

// Search implementation
async function search({ query, mode = 'hybrid-rerank', limit = 25, offset = 0 }) {

  try {
    const queryEmbedding = await embed(query);

    const results = await db.search(query, {
      mode,
      limit,
      offset,
      queryEmbedding
    });

    return { results };
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
function queueForSummarization(url, data) {
  console.log(`[SUMMARIZATION] Queueing page for summarization: ${url}`);
  console.table({ url, title: data.title, domain: data.domain, contentLength: data.text?.length || 0 });

  // Check if already in queue
  const existing = summarizationQueue.find(item => item.url === url);
  if (existing) {
    console.log(`[SUMMARIZATION] Page already in queue: ${url}`);
    return;
  }

  const queueItem = {
    id: Date.now() + Math.random(), // Simple unique ID
    url,
    data,
    timestamp: Date.now(),
    attempts: 0,
    maxAttempts: 3
  };

  summarizationQueue.push(queueItem);
  summaryQueueStats.queued = summarizationQueue.length;

  console.log(`[SUMMARIZATION] Queue updated. Total queued: ${summarizationQueue.length}`);

  // Start processing if not already running
  if (!isProcessingSummaries) {
    processSummaryQueue();
  }
}

function getSummaryQueueStats() {
  const stats = {
    ...summaryQueueStats,
    queueLength: summarizationQueue.length,
    isProcessing: isProcessingSummaries
  };

  console.log(`[SUMMARIZATION] Queue Stats:`, stats);
  if (summarizationQueue.length > 0) {
    console.log(`[SUMMARIZATION] Queued items:`, summarizationQueue.map(item => ({
      url: item.url,
      title: item.data.title,
      domain: item.data.domain,
      attempts: item.attempts
    })));
  }

  return stats;
}

function clearSummaryQueue() {
  console.log(`[SUMMARIZATION] Clearing queue with ${summarizationQueue.length} items`);
  summarizationQueue = [];
  summaryQueueStats = {
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    currentlyProcessing: null
  };
}

async function processSummaryQueue() {
  if (isProcessingSummaries) {
    console.log('[SUMMARIZATION] Queue processing already in progress');
    return;
  }

  if (summarizationQueue.length === 0) {
    console.log('[SUMMARIZATION] No items in queue to process');
    return;
  }

  isProcessingSummaries = true;
  console.log(`[SUMMARIZATION] Starting queue processing. ${summarizationQueue.length} items to process`);
  console.group('📝 Summarization Queue Processing');

  while (summarizationQueue.length > 0) {
    const item = summarizationQueue.shift();
    summaryQueueStats.queued = summarizationQueue.length;
    summaryQueueStats.currentlyProcessing = {
      url: item.url,
      title: item.data.title || 'Untitled',
      domain: item.data.domain || '',
      attempt: item.attempts + 1,
      maxAttempts: item.maxAttempts
    };

    console.log(`[SUMMARIZATION] Processing: ${item.url} (attempt ${item.attempts + 1}/${item.maxAttempts})`);

    try {
      summaryQueueStats.processing++;

      // Try to generate AI summary
      const aiSummary = await trySummarizeOffscreen(
        item.data.text,
        item.data.url,
        item.data.title
      );

      if (aiSummary && typeof aiSummary === 'string' && aiSummary.trim().length > 0) {
        // Update database with the AI-generated summary
        const updateResult = await db.updateSummaryByUrl(item.url, aiSummary);

        if (updateResult && updateResult.success) {
          console.log(`[SUMMARIZATION] ✅ Successfully updated summary for: ${item.url}`);
          summaryQueueStats.completed++;
        } else {
          console.warn(`[SUMMARIZATION] ⚠️ Failed to update database for: ${item.url}`, updateResult);
          summaryQueueStats.failed++;
        }
      } else {
        // AI summarization failed, but don't retry - fallback summary already exists
        console.log(`[SUMMARIZATION] ℹ️ AI summarization unavailable for: ${item.url}, keeping fallback summary`);
        summaryQueueStats.failed++;
      }

    } catch (error) {
      console.error(`[SUMMARIZATION] ❌ Error processing ${item.url}:`, error);

      item.attempts++;
      if (item.attempts < item.maxAttempts) {
        console.log(`[SUMMARIZATION] 🔄 Retrying ${item.url} (attempt ${item.attempts + 1}/${item.maxAttempts})`);
        // Add back to end of queue for retry
        summarizationQueue.push(item);
        summaryQueueStats.queued = summarizationQueue.length;
      } else {
        console.error(`[SUMMARIZATION] 💀 Max attempts reached for: ${item.url}`);
        summaryQueueStats.failed++;
      }
    }

    summaryQueueStats.currentlyProcessing = null;

    // Add a small delay between processing items to avoid overwhelming the AI API
    if (summarizationQueue.length > 0) {
      console.log(`[SUMMARIZATION] Waiting 2s before next item... (${summarizationQueue.length} remaining)`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  isProcessingSummaries = false;
  summaryQueueStats.queued = 0;

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

// Start summary queue processing periodically
setInterval(() => {
  if (!isProcessingSummaries && summarizationQueue.length > 0) {
    console.log('[SUMMARIZATION] Periodic check: starting queue processing');
    processSummaryQueue();
  }
}, 30000); // Check every 30 seconds
