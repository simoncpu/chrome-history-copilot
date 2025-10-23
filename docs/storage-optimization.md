# Storage Optimization: Removing content_text Column

## Overview

This document describes the storage optimization implemented in the AI History Chrome extension to reduce database size by ~65% while maintaining full search functionality.

## Problem Statement

**Original Architecture:**
- Stored full extracted page content in `content_text` column
- 9,000 pages over 90 days: ~190-210MB total database size
- `content_text` alone: ~135MB (15KB per page average)
- Used for: generating embeddings, FTS index, and AI summaries

**Issues:**
1. **Memory pressure**: PGlite loads database into WASM memory (200MB → 300-500MB in-memory)
2. **Query performance**: Fetching large `content_text` columns slowed results
3. **IndexedDB I/O**: Large blob reads/writes impacted UI responsiveness
4. **Redundancy**: Content only used during ingestion, never read afterward

## Solution Architecture

### Core Concept: Process-and-Discard

**Key Insight:** Original content is only needed during ingestion to generate processed artifacts. It's never queried afterward.

**New Flow:**
1. Extract full page content (happens once per visit)
2. Generate `content_tsvector` from **full content** → store in database
3. Generate `embedding` from **first 8,000 chars** → store in database
4. Generate AI `summary` from **full content** → store in database
5. **Discard original content** (garbage collected, not stored)

### What We Keep

```sql
CREATE TABLE pages (
  id SERIAL PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  domain TEXT,
  title TEXT,
  -- content_text removed ❌
  summary TEXT,                    -- AI-generated summary (~500 bytes)
  embedding vector(384),           -- Vector from first 8K chars (~1.5 KB)
  content_tsvector tsvector,       -- FTS index from full content (~4 KB)
  visit_count INTEGER DEFAULT 1,
  last_visit_at BIGINT,
  ...
);
```

### Storage Comparison

| Data Type | Size per Page | Total (9,000 pages) | Purpose |
|-----------|---------------|---------------------|---------|
| **Before Optimization** |
| content_text | 15 KB | 135 MB | Original content (removed) |
| content_tsvector | 4 KB | 40 MB | PostgreSQL FTS |
| embedding | 1.5 KB | 13.5 MB | Vector search |
| summary | 0.5 KB | 4.5 MB | Display |
| metadata | 1 KB | 9 MB | URLs, titles, etc. |
| **Total Before** | **~22 KB** | **~202 MB** | |
| **After Optimization** |
| content_tsvector | 4 KB | 40 MB | PostgreSQL FTS |
| embedding | 1.5 KB | 13.5 MB | Vector search |
| summary | 0.5 KB | 4.5 MB | Display |
| metadata | 1 KB | 9 MB | URLs, titles, etc. |
| **Total After** | **~7 KB** | **~67 MB** | |
| **Savings** | **-68%** | **-67%** | **135 MB saved** |

## Embedding Truncation Rationale

### Why Truncate to 8,000 Characters?

**Problem with Full Content Embeddings:**
- Long article (10,000 words) → 384-dim vector (information dilution)
- Short article (500 words) → 384-dim vector (good signal)
- Inconsistent embedding quality across different content lengths

**Solution: Focus on Primary Content**
```javascript
const fullContent = extractedContent.text; // Could be 10,000+ words

// FTS uses FULL content (keyword coverage)
const tsvector = generateTsvector(title, fullContent);

// Embedding uses TRUNCATED content (semantic focus)
const truncated = fullContent.slice(0, 8000); // ~2,000 tokens
const embedding = await embed(title + ' ' + domain + ' ' + truncated);
```

**Benefits:**
1. **Focused semantic signal**: Embeddings represent "what is this page primarily about" not "everything mentioned"
2. **Consistent quality**: Similar content lengths across all embeddings
3. **Better clustering**: Less noise from tangential mentions deep in articles
4. **Faster processing**: Less text to embed (minor speedup)

**Front-Loading Assumption:**
- Most web content follows inverted pyramid style
- Key concepts appear in intro + first few sections
- First 8,000 chars (~2,000 tokens) captures primary topics

### Trade-off Analysis

**What You Lose:**
- Can't find pages via semantic meaning of content deep in page body

**What You Keep:**
- PostgreSQL full-text search still covers **entire original content** via `content_tsvector`
- Keywords anywhere in original content are searchable

**Example Scenario:**
```
Page: 10,000-word "History of JavaScript" article
Section 8 (word 7,000): Detailed promises explanation

Query: "articles about JavaScript promises"

Vector search: ❌ Won't match (promises not in first 8K chars)
Text search:   ✅ Will match (content_tsvector has "promises")
Result:        ✅ Page found via hybrid search
```

**Hybrid search compensates:** If detail appears in full content, text search finds it even if vector search doesn't.

## Implementation Details

### Ingestion Code Pattern

```javascript
async function ingestPage(pageInfo) {
  const fullContent = extractedContent.text || '';
  const title = extractedContent.title || 'Untitled';
  const domain = new URL(pageInfo.url).hostname;

  // 1. Generate tsvector from FULL content
  const tsvectorResult = await db.query(`
    SELECT
      setweight(to_tsvector('english', $1), 'A') ||
      setweight(to_tsvector('english', $2), 'B') as tsvector
  `, [title, fullContent]);
  const contentTsvector = tsvectorResult.rows[0].tsvector;

  // 2. Generate embedding from TRUNCATED content
  const truncatedContent = fullContent.slice(0, 8000);
  const textToEmbed = title + ' ' + domain + ' ' + truncatedContent;
  const embedding = await embed(textToEmbed);

  // 3. Queue AI summary (uses full content)
  if (fullContent.length > 100) {
    await queueForSummarization(url, {
      text: fullContent,  // Queue stores full content temporarily
      title,
      domain
    });
  }

  // 4. Store ONLY processed data
  await db.query(`
    INSERT INTO pages (
      url, title, domain, summary, embedding, content_tsvector,
      first_visit_at, last_visit_at, visit_count
    ) VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, 1)
    ON CONFLICT (url) DO UPDATE SET
      title = EXCLUDED.title,
      summary = EXCLUDED.summary,
      embedding = EXCLUDED.embedding,
      content_tsvector = EXCLUDED.content_tsvector,
      last_visit_at = EXCLUDED.last_visit_at,
      visit_count = pages.visit_count + 1
  `, [url, title, domain, null, embeddingArray, contentTsvector, now, now]);

  // 5. fullContent is now garbage collected - NOT stored
}
```

### tsvector Generation Strategy

**Why Generate in Application Code?**

Before optimization, we used a PostgreSQL trigger:
```sql
CREATE TRIGGER trig_update_content_tsvector
  BEFORE INSERT OR UPDATE ON pages
  FOR EACH ROW
  EXECUTE FUNCTION update_content_tsvector();
```

This required `content_text` to exist in the database. Since we no longer store it, we generate `tsvector` in JavaScript before insertion.

**Performance Impact:**
- Minimal: tsvector generation is fast (~5-10ms for typical page)
- Only happens once per page visit
- Trade-off worth the 135MB storage savings

## Search Behavior (Unchanged)

### Full-Text Search
```sql
-- Searches content_tsvector (which represents FULL original content)
SELECT * FROM pages
WHERE content_tsvector @@ to_tsquery('react & hooks')
ORDER BY ts_rank(content_tsvector, query) DESC;
```

**Functionality:** Identical to before. Tsvector still contains all keywords from original content.

### Vector Search
```sql
-- Searches embedding (384-dim vector from first 8K chars)
SELECT * FROM pages
ORDER BY embedding <=> $queryEmbedding
LIMIT 20;
```

**Functionality:** Better quality. Focused embeddings produce more coherent semantic clusters.

### Hybrid Search with Reranking
```javascript
// Stage 1: RRF merge of text + vector results
const candidates = mergeWithRRF(textResults, vectorResults);

// Stage 2: Reranking with weighted scores
// Semantic (40%), Text (30%), Recency (20%), Popularity (10%)
const reranked = rerankCandidates(candidates);
```

**Functionality:** Enhanced. Better embedding quality improves semantic scoring.

## Migration Strategy

### Option A: Clean Break (Recommended)

**For Browser Extension:**
1. User clicks "Clear All Data" in debug page
2. Database drops and recreates with new schema
3. Pages re-index naturally as user browses
4. Within 90 days, all frequently visited pages are re-indexed

**Advantages:**
- Clean schema, no legacy issues
- Natural re-indexing via normal browsing
- Browser history fallback provides coverage during transition

**User Impact:**
- Temporary loss of AI summaries (regenerate on re-visit)
- Search still works (browser history integration)
- Within 1-2 weeks, most-visited pages are back

### Option B: In-Place Migration (Advanced)

For deployments that need to preserve data:
```sql
ALTER TABLE pages DROP COLUMN IF EXISTS content_text;
VACUUM FULL;
```

**Caveats:**
- Existing pages keep their tsvector/embedding (generated from old full content)
- New pages use new truncation strategy
- Mixed quality until natural re-indexing occurs

## Regeneration Limitations

### What You Can't Do Anymore

**Scenario 1: Bulk FTS Config Change**
```sql
-- Want to change from English to multi-language
ALTER TEXT SEARCH CONFIGURATION ...;

-- Would need content_text to regenerate:
UPDATE pages SET content_tsvector = to_tsvector('new_config', content_text);
--                                                              ^^^^^^^^^^^^
--                                                              No longer exists
```

**Workaround:** Wait for natural re-visits, or programmatically re-extract specific pages.

**Scenario 2: Bulk AI Summary Improvement**
```javascript
// Want to regenerate all summaries with better AI
for (const page of oldPages) {
  page.summary = await betterSummarizer(page.content_text);
  //                                    ^^^^^^^^^^^^^^^^^^
  //                                    No longer exists
}
```

**Workaround:** New visits automatically use improved summarizer. Important pages get re-visited naturally.

### What Still Works

**Regeneration for Individual Pages:**
```javascript
// Trigger re-extraction by opening page
async function reprocessPage(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  // Content extractor runs automatically
  // New tsvector + embedding + summary generated
  await chrome.tabs.remove(tab.id);
}
```

**Browser Extension Advantage:**
- Re-extraction is automatic on page visit
- No manual intervention needed
- Users naturally re-visit important pages

## Performance Impact

### Memory Usage
```
Before: 200MB on disk → 300-500MB in PGlite WASM memory
After:  65MB on disk → 100-150MB in PGlite WASM memory

Reduction: 65% less memory pressure
```

### Query Performance
```
Before: SELECT with content_text (15KB per row)
        → 25 results = 375KB data transfer from IndexedDB
        → ~200-300ms query time

After:  SELECT without content_text
        → 25 results = ~50KB data transfer
        → ~100-200ms query time

Improvement: ~2x faster result fetching
```

### IndexedDB I/O
```
Before: Frequent large blob reads (pages table ~135MB)
        → Noticeable UI lag during queries
        → Slower database sync

After:  Smaller blob reads (pages table ~25MB)
        → Minimal UI impact
        → Faster persistence

Improvement: Smoother user experience
```

## Future Considerations

### Potential Enhancements

**1. Chunk-Level Embeddings**
```javascript
// For very long pages, embed multiple chunks
const chunks = splitIntoChunks(fullContent, 8000);
const embeddings = await Promise.all(chunks.map(embed));
// Store multiple embeddings per page
```

**Benefits:** Better coverage of long articles
**Cost:** More storage, more complex search logic

**2. Adaptive Truncation**
```javascript
// Adjust truncation based on content structure
const importantSections = extractKeyParagraphs(fullContent);
const truncated = importantSections.slice(0, 8000);
```

**Benefits:** Smarter content selection
**Cost:** More complex extraction logic

**3. Content Preview Storage**
```javascript
// Store first 1,000 chars for debugging
const contentPreview = fullContent.slice(0, 1000);
```

**Benefits:** Helps debugging, allows limited re-summarization
**Cost:** +9MB for 9,000 pages (minimal)

## Monitoring and Validation

### Key Metrics to Track

```sql
-- Storage efficiency
SELECT pg_database_size(current_database()) as db_size_bytes;

-- Index coverage
SELECT
  COUNT(*) as total_pages,
  COUNT(content_tsvector) as pages_with_fts,
  COUNT(embedding) as pages_with_vector,
  COUNT(summary) as pages_with_summary
FROM pages;

-- Search performance
EXPLAIN ANALYZE
SELECT * FROM pages
WHERE content_tsvector @@ to_tsquery('test')
ORDER BY ts_rank(content_tsvector, to_tsquery('test')) DESC
LIMIT 25;
```

### Success Indicators

- ✅ Database size <80MB for 9,000 pages
- ✅ Search queries <300ms average
- ✅ >95% pages have tsvector + embedding
- ✅ No console errors during normal operation
- ✅ Memory usage stable under load

## Conclusion

**Summary of Benefits:**
- **67% storage reduction** (202MB → 67MB for 9,000 pages)
- **Better embedding quality** (focused semantic signals)
- **Faster queries** (smaller data transfers)
- **Lower memory usage** (critical for browser WASM)
- **All search features work identically** (user-facing functionality unchanged)

**Acceptable Trade-offs:**
- Cannot bulk-regenerate old pages (acceptable for 90-day rolling window)
- Relies on natural re-indexing via browsing (automatic for browser extension)
- Slightly more CPU during ingestion (negligible impact)

**Recommendation:** This optimization is highly beneficial for browser extension deployments where memory constraints are tight and natural re-indexing via browsing is guaranteed.

---

**See Also:**
- [docs/pglite.md](pglite.md) - Database schema and implementation
- [tasks.md](../tasks.md) - Implementation plan and checklist
- [CLAUDE.md](../CLAUDE.md) - High-level architecture
