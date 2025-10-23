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

    const instruction = `Analyze the user's query to decide if they are searching for information (is_search_query=true) or just chatting (is_search_query=false).

First, decide whether this is a search query.
- Treat as a search query when the user clearly asks for pages, articles, documents, bookmarks, examples, explanations, or asks "what did I read/about" or similar.
- If the query is casual chat, opinion, or conversational (no intent to find documents/pages), set is_search_query=false and return an empty keywords array.

When is_search_query=true, extract a small set of meaningful phrase-level keywords. Follow these rules:

1) Prioritize noun phrases and adjective+noun pairs. Output phrases that represent the core concept(s) of the search.
2) Keep multi-word terms together when they form a single concept (e.g., "machine learning", "react hooks", "python tutorials", "energy harvesting").
3) Remove filler and politeness: "please", "thanks", "find", "show me", "did i", "anything regarding", etc.
4) Remove vague placeholders and baby words: "thingy", "thing", "stuff", "whatever". If a placeholder is the only content, try to infer a real noun; otherwise drop it.
5) Remove action words and convert gerunds to the noun form when appropriate: "producing" -> drop or map to "production" only if needed. Prefer core nouns instead of verbs.
6) Prefer domain nouns over function words: keep "electricity" or "energy" rather than "producing".
7) Normalize terms: lowercase, strip punctuation, collapse duplicate words.
8) If multiple candidate phrases exist, return the minimal set that covers the user's intent (avoid long, redundant phrases).
9) Preserve quoted phrases exactly as one keyword.
10) If the query is ambiguous, prefer more general but meaningful phrases instead of long literal transcriptions.

Examples:
- "JavaScript tutorials" -> ["javascript tutorials"]
- "machine learning algorithms" -> ["machine learning algorithms"] or ["machine learning", "algorithms"]
- "React hooks documentation" -> ["react hooks", "documentation"]
- "Did I browse anything regarding wearable thingy producing electricity?" -> ["wearable electricity"]
- "find articles on energy harvesting wearables" -> ["energy harvesting wearables"] or ["wearable energy harvesting"]
- "please show me pages about 'quantum entanglement'" -> ["quantum entanglement"]

If not a search query, set is_search_query=false and return keywords: [].

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