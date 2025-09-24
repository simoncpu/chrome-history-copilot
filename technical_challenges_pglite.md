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

## Database Setup and Initialization

```javascript
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

// Initialize PGlite with pgvector extension and IndexedDB storage
async function initDatabase() {
  const db = new PGlite({
    dataDir: 'idb://ai-history-pglite',  // IndexedDB storage
    extensions: {
      vector,  // Enable pgvector extension
    }
  });

  // Wait for database to be ready
  await db.waitReady;

  // Enable pgvector extension
  await db.exec('CREATE EXTENSION IF NOT EXISTS vector');

  return db;
}
```

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
CREATE INDEX IF NOT EXISTS idx_pages_embedding
  ON pages USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);  -- Adjust lists parameter based on dataset size

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
  // Convert Float32Array to PostgreSQL array format
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
```

### Vector Similarity Search

```javascript
async function vectorSearch(db, queryEmbedding, limit = 25) {
  const embeddingArray = `[${Array.from(queryEmbedding).join(',')}]`;

  const result = await db.query(`
    SELECT
      id, url, title, domain,
      content_text, last_visit_at, visit_count,
      1 - (embedding <=> $1::vector) AS similarity
    FROM pages
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `, [embeddingArray, limit]);

  return result.rows;
}
```

## Full-Text Search with PostgreSQL

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
  // Normalize scores
  const maxTextRank = Math.max(...candidates.map(c => c.textRRF || 0));
  const maxSimilarity = Math.max(...candidates.map(c => c.similarity || 0));

  // Calculate hybrid scores with recency and popularity boosts
  const now = Date.now();
  const reranked = candidates.map(candidate => {
    // Normalize text and vector scores to [0, 1]
    const textScore = maxTextRank > 0 ? (candidate.textRRF || 0) / maxTextRank : 0;
    const vectorScore = maxSimilarity > 0 ? (candidate.similarity || 0) / maxSimilarity : 0;

    // Recency boost (decay over 30 days)
    const daysSinceVisit = (now - candidate.last_visit_at) / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.exp(-daysSinceVisit / 30);

    // Popularity boost (logarithmic)
    const popularityBoost = Math.log(candidate.visit_count + 1) / Math.log(100);

    // Weighted combination
    const finalScore =
      0.3 * textScore +
      0.5 * vectorScore +
      0.1 * recencyBoost +
      0.1 * popularityBoost;

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
      dataDir: 'idb://ai-history-pglite',
      extensions: { vector }
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

## Resources and References

- [PGlite Documentation](https://github.com/electric-sql/pglite)
- [pgvector Documentation](https://github.com/pgvector/pgvector)
- [PostgreSQL Full-Text Search](https://www.postgresql.org/docs/current/textsearch.html)
- [Vector Similarity Search Best Practices](https://github.com/pgvector/pgvector#best-practices)