# Technical Challenges: PGlite + pgvector

This document describes the implementation of PGlite with pgvector extension for the AI History Chrome extension, replacing the previous SQLite + sqlite-vec approach.

## Overview

PGlite is a lightweight PostgreSQL build compiled to WebAssembly (WASM) that runs entirely in the browser. Combined with the pgvector extension, it provides both traditional PostgreSQL capabilities and vector similarity search functionality.

## Key Advantages Over SQLite + sqlite-vec

1. **Native IndexedDB Support**: PGlite has built-in IndexedDB persistence, eliminating VFS complexity
2. **Full PostgreSQL Compatibility**: Complete SQL feature set including CTEs, window functions, and advanced indexing
3. **Integrated Full-Text Search**: Native PostgreSQL FTS with tsvector/tsquery, no need for FTS5 virtual tables
4. **pgvector Extension**: Production-ready vector similarity search with multiple index types
5. **Better Type System**: Native support for arrays, JSON, and custom types

## pgvector Extension Features

The pgvector extension is included in the main PGlite package (bundle size: 42.9 KB) and provides comprehensive vector operations:

### Supported Vector Types
- **Single-precision vectors**: Standard 32-bit floating point
- **Half-precision vectors**: 16-bit floating point for memory efficiency
- **Binary vectors**: For binary embeddings
- **Sparse vectors**: Optimized storage for vectors with many zero values

### Distance Metrics
- **L2 distance** (`<->` operator): Euclidean distance
- **Inner product** (`<#>` operator): Dot product similarity
- **Cosine distance** (`<=>` operator): Cosine similarity (most common for embeddings)
- **L1 distance** (`<+>` operator): Manhattan distance
- **Hamming distance**: For binary vectors
- **Jaccard distance**: For set-based similarity

### Search Capabilities
- **Exact nearest neighbor search**: Guaranteed accurate results
- **Approximate nearest neighbor search**: Faster search with index-based approximation

## Database Setup and Initialization

**IMPORTANT**: Chrome extensions MUST use IndexedDB VFS only. Do NOT use OPFS (Origin Private File System) as it causes WebAssembly compilation issues in Chrome extension contexts.

```javascript
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

// Initialize PGlite with pgvector extension and IndexedDB storage
async function initDatabase() {
  // Method 1: Simple dataDir prefix (recommended)
  const db = new PGlite({
    dataDir: 'idb://ai-history-pglite',  // IndexedDB VFS auto-selected
    extensions: {
      vector,  // Enable pgvector extension (42.9 KB bundle size)
    }
  });

  // Method 2: Explicit IdbFs (alternative approach)
  // import { IdbFs } from '@electric-sql/pglite/idbfs';
  // const db = new PGlite({
  //   fs: new IdbFs('ai-history-pglite'),
  //   extensions: { vector }
  // });

  // Wait for database to be ready
  await db.waitReady;

  // Enable pgvector extension
  await db.exec('CREATE EXTENSION IF NOT EXISTS vector');

  return db;
}
```

### pgvector Extension Setup

The pgvector extension is automatically available when imported and passed to the extensions configuration. It provides all standard pgvector functionality including:

- Vector data types and operations
- Multiple distance metrics (L2, cosine, inner product, etc.)
- Index support (IVFFlat, HNSW when available)
- Both exact and approximate nearest neighbor search

### Transformers.js Model Compatibility

The current Transformers.js models are fully compatible with pgvector:

**Local Model**: `Xenova/bge-small-en-v1.5-quantized`
- Output dimension: 384 (matches `vector(384)` schema)
- Type: Single-precision floating point (Float32Array)
- Optimized for Chrome extensions with quantization

**Remote Model**: `Xenova/bge-small-en-v1.5`
- Output dimension: 384 (matches `vector(384)` schema)
- Type: Single-precision floating point (Float32Array)
- Full precision version for better accuracy

Both models output 384-dimensional embeddings that are directly compatible with the pgvector `vector(384)` column type. The embeddings are normalized and use cosine similarity (`<=>` operator) for search, which is the standard approach for sentence embeddings.

### Chrome Extension Storage Requirements

PGlite provides two ways to configure IndexedDB VFS. For Chrome extensions, both methods work:

**Method 1: dataDir prefix (recommended for simplicity)**
```javascript
const db = new PGlite('idb://my-database');
```

**Method 2: Explicit IdbFs import**
```javascript
import { PGlite } from '@electric-sql/pglite';
import { IdbFs } from '@electric-sql/pglite/idbfs';

const db = new PGlite({
  fs: new IdbFs('my-database')
});
```

**Chrome Extension Requirements:**
- **MUST use**: One of the above IndexedDB VFS methods
- **MUST NOT use**: OPFS or any filesystem other than IndexedDB
- **Reason**: OPFS causes `WebAssembly.Module from an already read Response` errors in Chrome extensions
- **Storage**: IndexedDB stores whole PostgreSQL files (one per table/index) as blobs
- **Persistence**: Database automatically persists across browser sessions

## Schema Design

```sql
-- Main pages table with integrated vector column
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
  embedding vector(384),  -- 384-dimensional vector for embeddings
  content_tsvector tsvector,  -- Full-text search vector
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for efficient search
CREATE INDEX IF NOT EXISTS idx_pages_domain ON pages(domain);
CREATE INDEX IF NOT EXISTS idx_pages_last_visit ON pages(last_visit_at DESC);
CREATE INDEX IF NOT EXISTS idx_pages_visit_count ON pages(visit_count DESC);

-- Vector similarity search index (IVFFlat for large datasets)
-- pgvector supports multiple index types and operators
CREATE INDEX IF NOT EXISTS idx_pages_embedding_cosine
  ON pages USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);  -- For cosine distance searches

-- Alternative indexes for other distance metrics
-- CREATE INDEX idx_pages_embedding_l2
--   ON pages USING ivfflat (embedding vector_l2_ops)
--   WITH (lists = 100);  -- For L2 distance searches

-- CREATE INDEX idx_pages_embedding_ip
--   ON pages USING ivfflat (embedding vector_ip_ops)
--   WITH (lists = 100);  -- For inner product searches

-- Full-text search index
CREATE INDEX IF NOT EXISTS idx_pages_fts
  ON pages USING gin(content_tsvector);

-- Trigger to automatically update tsvector on insert/update
CREATE OR REPLACE FUNCTION update_content_tsvector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.content_tsvector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.content_text, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trig_update_content_tsvector
  BEFORE INSERT OR UPDATE ON pages
  FOR EACH ROW
  EXECUTE FUNCTION update_content_tsvector();
```

## Vector Operations with pgvector

### Storing Embeddings

```javascript
async function storePageWithEmbedding(db, pageData, embedding) {
  // Convert Float32Array from Transformers.js to PostgreSQL array format
  // embedding is a Float32Array(384) from the BGE model
  const embeddingArray = `[${Array.from(embedding).join(',')}]`;

  const result = await db.query(`
    INSERT INTO pages (
      url, domain, title, content_text,
      first_visit_at, last_visit_at, embedding
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
    ON CONFLICT (url) DO UPDATE SET
      title = EXCLUDED.title,
      content_text = EXCLUDED.content_text,
      last_visit_at = EXCLUDED.last_visit_at,
      visit_count = pages.visit_count + 1,
      embedding = EXCLUDED.embedding,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `, [
    pageData.url,
    pageData.domain,
    pageData.title,
    pageData.content_text,
    pageData.firstVisitAt,
    pageData.lastVisitAt,
    embeddingArray
  ]);

  return result.rows[0].id;
}

// Example: Generate embedding and store page
async function ingestPageWithEmbedding(db, pageData, embedder) {
  // Generate 384-dimensional embedding using Transformers.js
  const textToEmbed = `${pageData.title} ${pageData.content_text}`;
  const embedding = await embedder(textToEmbed, {
    pooling: 'mean',
    normalize: true
  });

  // embedding.data is Float32Array(384)
  const embeddingArray = embedding.data instanceof Float32Array
    ? embedding.data
    : new Float32Array(embedding.data);

  return await storePageWithEmbedding(db, pageData, embeddingArray);
}
```

### Vector Similarity Search

pgvector supports multiple distance operators for different use cases:

```javascript
async function vectorSearch(db, queryEmbedding, limit = 25, distanceType = 'cosine') {
  const embeddingArray = `[${Array.from(queryEmbedding).join(',')}]`;

  // Choose distance operator based on type
  let distanceOp, similarityCalc;
  switch (distanceType) {
    case 'cosine':
      distanceOp = '<=>';  // Cosine distance (most common for embeddings)
      similarityCalc = '1 - (embedding <=> $1::vector)';
      break;
    case 'l2':
      distanceOp = '<->';  // L2/Euclidean distance
      similarityCalc = '1 / (1 + (embedding <-> $1::vector))';
      break;
    case 'inner_product':
      distanceOp = '<#>';  // Inner product (negative for ORDER BY)
      similarityCalc = '-(embedding <#> $1::vector)';
      break;
    case 'l1':
      distanceOp = '<+>';  // L1/Manhattan distance
      similarityCalc = '1 / (1 + (embedding <+> $1::vector))';
      break;
    default:
      distanceOp = '<=>';
      similarityCalc = '1 - (embedding <=> $1::vector)';
  }

  const result = await db.query(`
    SELECT
      id, url, title, domain,
      content_text, last_visit_at, visit_count,
      ${similarityCalc} AS similarity
    FROM pages
    WHERE embedding IS NOT NULL
    ORDER BY embedding ${distanceOp} $1::vector
    LIMIT $2
  `, [embeddingArray, limit]);

  return result.rows;
}

// Convenience functions for specific distance types
async function cosineSimilaritySearch(db, queryEmbedding, limit = 25) {
  return vectorSearch(db, queryEmbedding, limit, 'cosine');
}

async function euclideanDistanceSearch(db, queryEmbedding, limit = 25) {
  return vectorSearch(db, queryEmbedding, limit, 'l2');
}
```

## Full-Text Search with PostgreSQL

**Important Note**: This implementation uses PostgreSQL's `ts_rank()` function, which is a TF-IDF-like algorithm, **NOT BM25**. While BM25 is often considered superior for text search, PostgreSQL doesn't have native BM25 support. The `ts_rank()` function provides effective text relevance scoring based on term frequency and document length normalization.

**ts_rank vs BM25**:
- **ts_rank**: PostgreSQL's built-in TF-IDF variant with document length normalization
- **BM25**: More sophisticated algorithm with tunable parameters (k1, b) for term saturation
- **Performance**: ts_rank is well-optimized in PostgreSQL and provides good results for most use cases
- **Alternative**: ParadeDB's pg_bm25 extension would provide true BM25, but it's not available for PGlite/WASM environments

```javascript
async function fullTextSearch(db, query, limit = 25) {
  // Escape special characters and prepare query
  const tsQuery = query.split(' ')
    .filter(term => term.length > 0)
    .map(term => `${term}:*`)
    .join(' & ');

  const result = await db.query(`
    SELECT
      id, url, title, domain, content_text,
      last_visit_at, visit_count,
      ts_rank(content_tsvector, query) AS rank
    FROM pages,
         plainto_tsquery('english', $1) AS query
    WHERE content_tsvector @@ query
    ORDER BY rank DESC, last_visit_at DESC
    LIMIT $2
  `, [query, limit]);

  return result.rows;
}
```

## Hybrid Search Implementation

```javascript
async function hybridSearch(db, query, queryEmbedding, mode = 'hybrid-rerank', limit = 25) {
  if (mode === 'text') {
    return await fullTextSearch(db, query, limit);
  }

  if (mode === 'vector') {
    return await vectorSearch(db, queryEmbedding, limit);
  }

  // Hybrid search with RRF (Reciprocal Rank Fusion)
  const textResults = await fullTextSearch(db, query, 100);
  const vectorResults = await vectorSearch(db, queryEmbedding, 100);

  // RRF merge
  const k = 60;  // RRF constant
  const scoreMap = new Map();

  // Calculate RRF scores for text results
  textResults.forEach((result, rank) => {
    const rrf = 1 / (k + rank + 1);
    scoreMap.set(result.id, {
      ...result,
      textRank: rank,
      textRRF: rrf,
      vectorRRF: 0,
      totalRRF: rrf
    });
  });

  // Add vector scores
  vectorResults.forEach((result, rank) => {
    const rrf = 1 / (k + rank + 1);
    const existing = scoreMap.get(result.id);
    if (existing) {
      existing.vectorRank = rank;
      existing.vectorRRF = rrf;
      existing.similarity = result.similarity;
      existing.totalRRF = existing.textRRF + rrf;
    } else {
      scoreMap.set(result.id, {
        ...result,
        vectorRank: rank,
        vectorRRF: rrf,
        textRRF: 0,
        totalRRF: rrf
      });
    }
  });

  // Sort by combined RRF score
  const candidates = Array.from(scoreMap.values())
    .sort((a, b) => b.totalRRF - a.totalRRF);

  if (mode === 'hybrid-rrf') {
    return candidates.slice(0, limit);
  }

  // Hybrid with reranking
  return await rerankCandidates(db, candidates, query, limit);
}

async function rerankCandidates(db, candidates, query, limit) {
  // This function uses min-max normalization and weighted scoring
  // Text scores come from PostgreSQL's ts_rank (NOT BM25)

  const now = Date.now();

  // Build lookup maps for vector distances and text rank scores
  const textResults = await fullTextSearch(db, query, 300);
  const vectorResults = await vectorSearch(db, queryEmbedding, 300);

  const textRankMap = new Map();
  const vecDistMap = new Map();

  textResults.forEach(d => {
    if (d.id != null && typeof d.rank === 'number')
      textRankMap.set(d.id, d.rank);
  });
  vectorResults.forEach(d => {
    if (d.id != null && typeof d.distance === 'number')
      vecDistMap.set(d.id, d.distance);
  });

  // Normalize scores using min-max normalization
  const textRankVals = Array.from(textRankMap.values());
  const vecVals = Array.from(vecDistMap.values());

  const normalizeTextRank = createNormalizer(textRankVals, false); // higher is better
  const normalizeVector = createNormalizer(vecVals, true); // smaller distance is better

  // Scoring weights: semantic (50%), text relevance (30%), recency (10%), popularity (10%)
  const wVec = 0.5, wTextRank = 0.3, wRec = 0.1, wVis = 0.1;

  const reranked = candidates.map(candidate => {
    // Get normalized scores
    const vectorScore = normalizeVector(vecDistMap.get(candidate.id) || 1.0);
    const textScore = normalizeTextRank(textRankMap.get(candidate.id) || 0);

    // Recency boost (exponential decay over 30 days)
    const daysSinceVisit = (now - candidate.last_visit_at) / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.exp(-daysSinceVisit / 30);

    // Popularity boost (logarithmic scale)
    const maxVisits = Math.max(1, ...candidates.map(c => c.visit_count || 0));
    const popularityBoost = Math.log(candidate.visit_count + 1) / Math.log(maxVisits + 1);

    // Additional boost factors
    const titleBoost = candidate.title?.toLowerCase().includes(query.toLowerCase()) ? 0.15 : 0;
    const domainBoost = candidate.domain?.toLowerCase().includes(query.toLowerCase()) ? 0.1 : 0;
    const urlBoost = candidate.url?.toLowerCase().includes(query.toLowerCase()) ? 0.08 : 0;

    // Final weighted score
    const finalScore = (wVec * vectorScore) + (wTextRank * textScore) +
                      (wRec * recencyBoost) + (wVis * popularityBoost) +
                      titleBoost + domainBoost + urlBoost;

    return {
      ...candidate,
      finalScore,
      textScore,
      vectorScore,
      recencyBoost,
      popularityBoost
    };
  });

  // Sort by final score and return top N
  return reranked
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, limit);
}
```

## Chrome Extension Integration

### Offscreen Document Setup

```javascript
// offscreen.js
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

let db = null;
let isInitialized = false;

async function initializeDatabase() {
  if (db) return db;

  try {
    console.log('[DB] Initializing PGlite database with IndexedDB storage');

    db = new PGlite({
      dataDir: 'idb://ai-history-pglite',  // IndexedDB VFS auto-selected
      extensions: { vector }
      // Note: Do NOT use fs: 'idb' - causes "fs.init is not a function" errors
    });

    await db.waitReady;
    await db.exec('CREATE EXTENSION IF NOT EXISTS vector');

    // Create schema
    await createSchema(db);

    // Verify storage backend
    console.log('[DB] ✅ Using IndexedDB storage - safe for Chrome extension');

    isInitialized = true;
    return db;
  } catch (error) {
    console.error('[DB] Failed to initialize PGlite:', error);
    throw error;
  }
}

// Message handler for Chrome extension
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'db-operation') {
    handleDatabaseOperation(request.operation, request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;  // Async response
  }
});
```

### Database Persistence

PGlite automatically handles persistence through IndexedDB:
- Database stored at key `ai-history-pglite` in IndexedDB
- All changes automatically persisted
- No manual sync or flush operations needed
- Database survives browser restarts
- Works across all Chrome extension contexts

## Performance Optimizations

### Index Tuning

```sql
-- For datasets < 10,000 rows, use btree index
CREATE INDEX idx_pages_embedding_btree
  ON pages USING btree (embedding);

-- For datasets > 10,000 rows, use IVFFlat
CREATE INDEX idx_pages_embedding_ivfflat
  ON pages USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);  -- lists = sqrt(num_rows) / 10

-- For datasets > 100,000 rows, use HNSW (if available)
CREATE INDEX idx_pages_embedding_hnsw
  ON pages USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

### Query Optimization

```javascript
// Use EXPLAIN ANALYZE to optimize queries
async function analyzeQuery(db, query, params) {
  const result = await db.query(`EXPLAIN ANALYZE ${query}`, params);
  console.log('[DB] Query plan:', result.rows);
  return result;
}

// Batch inserts for better performance
async function batchInsertPages(db, pages) {
  const values = pages.map((page, idx) => {
    const offset = idx * 7;
    return `($${offset + 1}, $${offset + 2}, $${offset + 3},
             $${offset + 4}, $${offset + 5}, $${offset + 6},
             $${offset + 7}::vector)`;
  }).join(',');

  const params = pages.flatMap(page => [
    page.url, page.domain, page.title,
    page.content_text, page.first_visit_at,
    page.last_visit_at, `[${Array.from(page.embedding).join(',')}]`
  ]);

  await db.query(`
    INSERT INTO pages (url, domain, title, content_text,
                      first_visit_at, last_visit_at, embedding)
    VALUES ${values}
    ON CONFLICT (url) DO UPDATE SET
      last_visit_at = EXCLUDED.last_visit_at,
      visit_count = pages.visit_count + 1
  `, params);
}
```

## Error Handling and Fallbacks

```javascript
// Graceful degradation when pgvector unavailable
async function searchWithFallback(db, query, embedding, mode) {
  try {
    if (embedding && mode !== 'text') {
      return await hybridSearch(db, query, embedding, mode);
    }
  } catch (error) {
    console.warn('[DB] Vector search failed, falling back to text-only:', error);
  }

  // Fallback to text-only search
  try {
    return await fullTextSearch(db, query);
  } catch (error) {
    console.warn('[DB] Full-text search failed, falling back to ILIKE:', error);
    // Final fallback to simple pattern matching
    return await db.query(`
      SELECT id, url, title, domain, content_text,
             last_visit_at, visit_count
      FROM pages
      WHERE title ILIKE $1 OR content_text ILIKE $1
      ORDER BY last_visit_at DESC
      LIMIT 25
    `, [`%${query}%`]);
  }
}
```

## Migration from SQLite

For existing SQLite databases, provide a migration path:

```javascript
async function migrateFromSQLite(sqliteDb, pgliteDb) {
  // Export from SQLite
  const pages = await sqliteDb.exec(`
    SELECT p.*, e.embedding
    FROM pages p
    LEFT JOIN page_embeddings e ON p.id = e.id
  `);

  // Batch insert into PGlite
  for (const batch of chunk(pages, 100)) {
    await batchInsertPages(pgliteDb, batch);
  }

  console.log(`[DB] Migrated ${pages.length} pages to PGlite`);
}
```

## Testing and Validation

```javascript
// Verify vector operations
async function testVectorOps(db) {
  // Test vector storage
  const testEmbedding = new Float32Array(384).fill(0.1);
  await db.query(
    'INSERT INTO pages (url, embedding) VALUES ($1, $2::vector)',
    ['test://vector', `[${Array.from(testEmbedding).join(',')}]`]
  );

  // Test vector search
  const results = await db.query(`
    SELECT url, embedding <=> $1::vector AS distance
    FROM pages
    WHERE url = 'test://vector'
  `, [`[${Array.from(testEmbedding).join(',')}]`]);

  console.assert(results.rows[0].distance === 0, 'Vector roundtrip failed');

  // Cleanup
  await db.query('DELETE FROM pages WHERE url = $1', ['test://vector']);
}

// Verify full-text search
async function testFTS(db) {
  await db.query(
    'INSERT INTO pages (url, title, content_text) VALUES ($1, $2, $3)',
    ['test://fts', 'Test Page', 'This is test content for full-text search']
  );

  const results = await db.query(`
    SELECT url, ts_rank(content_tsvector, query) AS rank
    FROM pages, plainto_tsquery('english', $1) AS query
    WHERE url = 'test://fts' AND content_tsvector @@ query
  `, ['test content']);

  console.assert(results.rows.length > 0, 'FTS failed');

  // Cleanup
  await db.query('DELETE FROM pages WHERE url = $1', ['test://fts']);
}
```

## Common Issues and Solutions

### WebAssembly Compilation Errors

**Issue**: `TypeError: Failed to execute 'compile' on 'WebAssembly': Cannot compile WebAssembly.Module from an already read Response`

**Cause**: PGlite attempts to use OPFS (Origin Private File System) by default, which is incompatible with Chrome extension security contexts.

**Root Cause**: Chrome extensions run in a restricted environment where OPFS access patterns conflict with WebAssembly module loading, causing the WASM compilation to fail when trying to read from an already-consumed Response stream.

**Solution**: Use proper IndexedDB VFS configuration:

```javascript
// Method 1: dataDir prefix (recommended)
const pglite = new PGlite({
  dataDir: 'idb://ai-history-pglite',  // IndexedDB VFS auto-selected
  extensions: { vector }
});

// Method 2: Explicit IdbFs import (alternative)
import { IdbFs } from '@electric-sql/pglite/idbfs';
const pglite = new PGlite({
  fs: new IdbFs('ai-history-pglite'),
  extensions: { vector }
});
```

**Why This Works**: Both methods properly configure IndexedDB VFS, avoiding OPFS/WASM conflicts. The incorrect `fs: 'idb'` string option is not supported and causes "fs.init is not a function" errors.

### PostgreSQL Trigger Syntax Issues

**Issue**: `syntax error at or near "NOT" ... CREATE TRIGGER IF NOT EXISTS`

**Cause**: PostgreSQL doesn't support `IF NOT EXISTS` for triggers.

**Solution**: Drop and recreate the trigger:

```javascript
await db.exec(`
  DROP TRIGGER IF EXISTS trig_update_content_tsvector ON pages;
  CREATE TRIGGER trig_update_content_tsvector
    BEFORE INSERT OR UPDATE ON pages
    FOR EACH ROW
    EXECUTE FUNCTION update_content_tsvector();
`);
```

### PGlite Filesystem Option Errors

**Issue**: `TypeError: this.fs.init is not a function`

**Cause**: Using explicit `fs: 'idb'` option with PGlite constructor.

**Solution**: Use proper IndexedDB VFS configuration methods:

```javascript
// ❌ Wrong - causes fs.init errors
const db = new PGlite({
  dataDir: 'idb://ai-history-pglite',
  extensions: { vector },
  fs: 'idb'  // This string option doesn't exist
});

// ✅ Correct Method 1 - dataDir prefix
const db = new PGlite({
  dataDir: 'idb://ai-history-pglite',  // Automatically uses IndexedDB VFS
  extensions: { vector }
});

// ✅ Correct Method 2 - explicit IdbFs
import { IdbFs } from '@electric-sql/pglite/idbfs';
const db = new PGlite({
  fs: new IdbFs('ai-history-pglite'),  // Proper IdbFs instance
  extensions: { vector }
});
```

### Chrome Extension Bundle Files

**Note**: The `chunk-*.js` files in `lib/` are required PGlite dependencies generated during build. Do not remove these files as they contain essential WASM loading and runtime code.

### IndexedDB Storage Verification

Always verify that IndexedDB storage is being used for Chrome extension compatibility:

```javascript
// This should log success for Chrome extensions
console.log('[DB] ✅ Using IndexedDB storage - safe for Chrome extension');

// Verify the database is accessible
const testQuery = await db.query('SELECT 1 as test');
console.assert(testQuery.rows[0].test === 1, 'Database connectivity failed');
```

### PGlite Initialization Race Conditions

**Issue**: `Cannot read properties of undefined (reading 'mode')` during IndexedDB initialization

**Cause**: Chrome extensions can receive search requests before PGlite has finished initializing its IndexedDB storage, causing race conditions during database startup.

**Root Cause**: PGlite's IndexedDB initialization is asynchronous and can take several seconds. If the UI sends search requests immediately after extension startup, they may arrive before the database is ready.

**Solution**: Implement proper initialization state management:

```javascript
// Track initialization state
let isInitialized = false;
let isInitializing = false;
let initializationPromise = null;

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
    // Handle message...
  } catch (error) {
    sendResponse({ error: error.message });
  }
}
```

**UI Integration**: The search UI shows loading shimmer during initialization and automatically waits for database readiness.

### Extension Reload Requirements

If you encounter "Unknown message type" errors, reload the extension at `chrome://extensions/` to refresh the offscreen document and its dependencies.

## Resources and References

- [PGlite Documentation](https://github.com/electric-sql/pglite)
- [pgvector Documentation](https://github.com/pgvector/pgvector)
- [PostgreSQL Full-Text Search](https://www.postgresql.org/docs/current/textsearch.html)
- [Vector Similarity Search Best Practices](https://github.com/pgvector/pgvector#best-practices)