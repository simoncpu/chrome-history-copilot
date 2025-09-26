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

    const instruction = `Analyze the user's query to determine if they are searching for specific information or just chatting.

First, determine if this is a search query:
- Search queries: "find pages about X", "show me articles on Y", "what did I read about Z", "my bookmarks on topic"
- Non-search queries: "hello", "hi", "thanks", "how are you", "what can you do", casual conversation

Then extract keywords only if it's a search query:

Rules for keyword extraction (only when is_search_query=true):
- Keep 1-5 concise keywords or phrases
- Prefer nouns and noun-phrases; drop politeness words
- Preserve quoted phrases exactly
- Lowercase; lemmatize (cats -> cat)
- Remove stopwords and filler (please, info, give me)

If not a search query, set is_search_query=false and leave all arrays empty.

User query: "${query}"

Response must be valid JSON with this exact format:
{
  "is_search_query": true/false,
  "keywords": ["array", "of", "strings"],
  "phrases": ["exact phrases"],
  "must_include": ["required", "terms"],
  "must_exclude": ["forbidden", "terms"]
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

      for (const key of ['keywords', 'phrases', 'must_include', 'must_exclude']) {
        extracted[key] = (extracted[key] || []).map(s => s.toLowerCase().trim()).filter(s => s.length > 0);
      }

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
          description: "True if the user is searching for specific information, false if just chatting/greeting"
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "General search terms (empty if not searching)"
        },
        phrases: {
          type: "array",
          items: { type: "string" },
          description: "Exact phrases to search for (empty if not searching)"
        },
        must_include: {
          type: "array",
          items: { type: "string" },
          description: "Terms that must be present (empty if not searching)"
        },
        must_exclude: {
          type: "array",
          items: { type: "string" },
          description: "Terms that must not be present (empty if not searching)"
        }
      },
      required: ["is_search_query", "keywords", "phrases", "must_include", "must_exclude"]
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