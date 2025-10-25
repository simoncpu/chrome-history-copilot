/**
 * AI History - Keyword Extraction Service
 * Uses Chrome AI Prompt API with JSON Schema responseConstraint for structured keyword extraction
 */

import { chromeAILoader } from './chrome-ai-loader.js';

export class KeywordExtractor {
  constructor() {
    this.extractionSession = null;
  }

  /**
   * Extract keywords from natural language query using Chrome AI
   */
  async extractKeywords(query, onProgress = null) {
    if (!this.extractionSession) {
      await this.createExtractionSession(onProgress);
    }

    const instruction = `Analyze the user's query and decide whether they are searching for information (is_search_query=true) or simply asking a conversational or meta question (is_search_query=false).

Step 1 - Determine if this is a search query
A query should be treated as a **search query (is_search_query=true)** only when:
- The user is trying to find or recall pages, articles, documents, bookmarks, or website content they have read or visited.
- The phrasing clearly indicates an intent to *retrieve information* from the user's browsing history or the web.
Examples of search phrasing: "find pages about...", "did I read about...", "what did I browse on...", "show me my history about...", etc.

All other types of questions must be treated as **non-search (is_search_query=false)**, including:
1. **Meta/self questions** about the assistant, the extension, or its capabilities.
2. **System/AI introspection** questions (e.g., "are you self aware", "what model are you", "how do you work").
3. **Extension or tool behavior** questions ("how many pages have you indexed", "does the extension store my data", "how do I install this", "how do you analyze history").
4. **Programming or configuration** questions about implementation, bugs, or features ("how do I fix the extension", "what API are you using").
5. **General conversation** or off-topic chatter that is not an attempt to recall or search through data.

If the query falls into any of those categories, always output:
{
  "is_search_query": false,
  "keywords": []
}

Step 2 - When is_search_query=true
Extract a minimal set of meaningful phrases that represent the *topic being searched*. Follow these rules:

1) Focus on noun phrases or adjective+noun pairs that capture the topic.
2) Keep multi-word terms together when they form a concept (e.g., "machine learning", "energy harvesting wearables").
3) Remove filler words, politeness, and vague placeholders ("thingy", "stuff", "please", "anything regarding", etc.).
4) Remove action words unless central to meaning; prefer core nouns over verbs ("producing electricity" → "electricity").
5) Normalize to lowercase, strip punctuation, and avoid redundancy.
6) Preserve quoted phrases exactly as one keyword.
7) Include only the fewest phrases needed to cover the user's intent.

Step 3 - Examples

Search queries (is_search_query=true):
- "Did I browse anything regarding wearable thingy producing electricity?"  
  -> { "is_search_query": true, "keywords": ["wearable electricity"] }
- "find pages on energy harvesting wearables"  
  -> { "is_search_query": true, "keywords": ["energy harvesting wearables"] }
- "what did I read about quantum computing"  
  -> { "is_search_query": true, "keywords": ["quantum computing"] }

Meta/self/extension questions (is_search_query=false):
- "how many pages have you indexed?"  
- "are you self aware?"  
- "how do you work?"  
- "what model are you?"  
- "how do I install the extension?"  
- "does the extension store my data?"  
- "what APIs are you using?"  
- "did you build that chrome copilot?"  
-> { "is_search_query": false, "keywords": [] }

User query: "${query}"

Response must be valid JSON with exactly this format:
{
  "is_search_query": true/false,
  "keywords": ["array", "of", "meaningful", "phrases"]
}`;

    try {
      console.log('[KEYWORD-EXTRACTOR] Calling prompt with instruction...');

      let response;
      // Use responseConstraint for structured output (Chrome 138+)
      try {
        response = await this.extractionSession.prompt(instruction, {
          responseConstraint: this.getExtractionSchema(),
          omitResponseConstraintInput: true
        });
        console.log('[KEYWORD-EXTRACTOR] Used responseConstraint for structured output');
      } catch (constraintError) {
        console.warn('[KEYWORD-EXTRACTOR] responseConstraint failed, falling back to plain prompt:', constraintError);
        response = await this.extractionSession.prompt(instruction);
      }

      console.log('[KEYWORD-EXTRACTOR] Raw response:', response);

      // Parse JSON response
      let extracted;
      try {
        extracted = JSON.parse(response);
      } catch (parseError) {
        // Try to extract JSON from response if it's wrapped in other text
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          extracted = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error(`Response is not valid JSON: ${response}`);
        }
      }

      // Post-process: ensure lowercase and trim, and validate is_search_query
      if (typeof extracted.is_search_query !== 'boolean') {
        extracted.is_search_query = false;
      }

      // Process keywords array
      extracted.keywords = (extracted.keywords || []).map(s => s.toLowerCase().trim()).filter(s => s.length > 0);

      console.log('[KEYWORD-EXTRACTOR] Extracted:', extracted);
      return extracted;
    } catch (error) {
      console.error('[KEYWORD-EXTRACTOR] Failed to extract keywords:', error);
      throw new Error(`Keyword extraction failed: ${error.message}`);
    }
  }

  /**
   * Create extraction session with proper configuration
   */
  async createExtractionSession(onProgress = null) {
    console.log('[KEYWORD-EXTRACTOR] Creating extraction session...');

    // Wait for Chrome AI APIs to become available
    if (onProgress) {
      onProgress('Waiting for Chrome AI to load...');
    }

    const apiInfo = await chromeAILoader.waitForChromeAI(onProgress);
    console.log('[KEYWORD-EXTRACTOR] Chrome AI APIs loaded:', apiInfo);

    if (onProgress) {
      onProgress('Creating keyword extraction session...');
    }

    try {
      const availability = await LanguageModel.availability();
      console.log(`[KEYWORD-EXTRACTOR] LanguageModel availability: ${availability}`);

      if (availability === 'downloadable' || availability === 'downloading') {
        console.log(`[KEYWORD-EXTRACTOR] Model status: ${availability}, proceeding with session creation`);
      }

      // Create session optimized for keyword extraction
      this.extractionSession = await LanguageModel.create({
        initialPrompts: [{
          role: 'system',
          content: 'You are a keyword extraction system. You only output valid JSON matching the provided schema.'
        }],
        temperature: 0.1, // Low temperature for consistent extraction
        topK: 1 // Focused output
      });

      console.log('[KEYWORD-EXTRACTOR] Session created successfully');

      if (onProgress) {
        onProgress('Keyword extraction ready!');
      }

    } catch (error) {
      console.error('[KEYWORD-EXTRACTOR] Failed to create session:', error);
      throw new Error(`Failed to create keyword extraction session: ${error.message}`);
    }
  }

  /**
   * Get JSON schema for keyword extraction
   */
  getExtractionSchema() {
    return {
      type: "object",
      additionalProperties: false,
      properties: {
        is_search_query: {
          type: "boolean",
          description: "True if the user is searching for specific information, false if just chatting"
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "General search terms (empty if not searching)"
        }
      },
      required: ["is_search_query", "keywords"]
    };
  }

  /**
   * Test extraction with example queries
   */
  async testExtraction() {
    const testQueries = [
      "Find me JavaScript tutorials I visited last week",
      "Show pages about machine learning but not TensorFlow",
      "\"React hooks\" documentation pages",
      "Python programming tutorials excluding beginner guides",
      "Show me all the AI research papers I bookmarked"
    ];

    const results = [];
    for (const query of testQueries) {
      try {
        const extracted = await this.extractKeywords(query);
        results.push({ query, extracted, success: true });
      } catch (error) {
        results.push({ query, error: error.message, success: false });
      }
    }

    return results;
  }

  /**
   * Cleanup session
   */
  async cleanup() {
    if (this.extractionSession) {
      try {
        await this.extractionSession.destroy();
      } catch (error) {
        console.warn('[KEYWORD-EXTRACTOR] Failed to cleanup session:', error);
      }
      this.extractionSession = null;
    }
  }
}

// Create global instance
export const keywordExtractor = new KeywordExtractor();

// For non-module usage
window.KeywordExtractor = KeywordExtractor;
window.keywordExtractor = keywordExtractor;