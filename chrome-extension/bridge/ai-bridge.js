/**
 * AI History - AI Bridge Client
 * Provides a clean API for UI components to interact with Chrome's AI APIs
 */

export class AIBridge {
  constructor() {
    this.languageSession = null;
    this.summarizerSession = null;
    this.capabilities = null;
    this.isInitialized = false;
  }

  /**
   * Initialize AI capabilities
   */
  async initialize() {
    if (this.isInitialized) return this.capabilities;

    try {
      // Check if Chrome AI is available
      if (!window.ai) {
        throw new Error('Chrome AI APIs not available');
      }

      // Get language model capabilities
      if (window.ai.languageModel) {
        this.capabilities = {
          languageModel: await window.ai.languageModel.capabilities(),
          summarizer: window.ai.summarizer ? await window.ai.summarizer.capabilities() : null
        };
      } else {
        this.capabilities = { languageModel: null, summarizer: null };
      }

      this.isInitialized = true;
      return this.capabilities;
    } catch (error) {
      console.warn('[AI-BRIDGE] Failed to initialize AI capabilities:', error);
      this.capabilities = { languageModel: null, summarizer: null };
      this.isInitialized = true;
      return this.capabilities;
    }
  }

  /**
   * Check if language model is available
   */
  async isLanguageModelAvailable() {
    await this.initialize();
    return this.capabilities?.languageModel?.available === 'readily';
  }

  /**
   * Check if summarizer is available
   */
  async isSummarizerAvailable() {
    await this.initialize();
    return this.capabilities?.summarizer?.available === 'readily';
  }

  /**
   * Create a language model session
   */
  async createLanguageSession(options = {}) {
    await this.initialize();

    if (!window.ai?.languageModel) {
      throw new Error('Language model not available');
    }

    const sessionOptions = {
      systemPrompt: options.systemPrompt || this.getDefaultSystemPrompt(),
      temperature: options.temperature || 0.7,
      topK: options.topK || 3,
      ...options
    };

    try {
      this.languageSession = await window.ai.languageModel.create(sessionOptions);
      return this.languageSession;
    } catch (error) {
      console.error('[AI-BRIDGE] Failed to create language session:', error);
      throw error;
    }
  }

  /**
   * Get default system prompt for history chat
   */
  getDefaultSystemPrompt() {
    return `You are an AI assistant that helps users find information from their browsing history.

Your responsibilities:
1. Answer questions based ONLY on the provided browsing history snippets
2. Always include clickable links when referencing specific pages
3. Keep responses concise and helpful (2-4 sentences typically)
4. If no relevant information is found, say so clearly
5. Use markdown formatting for better readability

Format guidelines:
- Use **bold** for emphasis
- Include links as [Page Title](URL)
- Use bullet points for lists
- Be direct and actionable

Remember: You can only reference information from the provided browsing history context.`;
  }

  /**
   * Generate a response using the language model
   */
  async generateResponse(prompt, context = '') {
    if (!this.languageSession) {
      await this.createLanguageSession();
    }

    const fullPrompt = context ? `Context from browsing history:\n${context}\n\nUser question: ${prompt}` : prompt;

    try {
      const response = await this.languageSession.prompt(fullPrompt);
      return response;
    } catch (error) {
      console.error('[AI-BRIDGE] Failed to generate response:', error);
      throw error;
    }
  }

  /**
   * Generate a streaming response
   */
  async generateStreamingResponse(prompt, context = '', onChunk = null) {
    if (!this.languageSession) {
      await this.createLanguageSession();
    }

    const fullPrompt = context ? `Context from browsing history:\n${context}\n\nUser question: ${prompt}` : prompt;

    try {
      const stream = await this.languageSession.promptStreaming(fullPrompt);
      let fullResponse = '';

      for await (const chunk of stream) {
        fullResponse = chunk;
        if (onChunk) {
          onChunk(chunk);
        }
      }

      return fullResponse;
    } catch (error) {
      console.error('[AI-BRIDGE] Failed to generate streaming response:', error);
      throw error;
    }
  }

  /**
   * Build context from search results
   */
  buildContext(searchResults, maxResults = 8) {
    if (!searchResults || searchResults.length === 0) {
      return 'No relevant browsing history found.';
    }

    const results = searchResults.slice(0, maxResults);

    return results.map((result, index) => {
      const title = result.title || 'Untitled';
      const url = result.url;
      const content = result.summary || result.snippet || result.content_text || '';
      const trimmedContent = content.length > 200 ? content.substring(0, 200) + '...' : content;

      return `${index + 1}. **${title}**
   URL: ${url}
   Content: ${trimmedContent}`;
    }).join('\n\n');
  }

  /**
   * Create a summarizer session
   */
  async createSummarizerSession(options = {}) {
    await this.initialize();

    if (!window.ai?.summarizer) {
      throw new Error('Summarizer not available');
    }

    const sessionOptions = {
      type: options.type || 'tl;dr',
      format: options.format || 'markdown',
      length: options.length || 'short',
      ...options
    };

    try {
      this.summarizerSession = await window.ai.summarizer.create(sessionOptions);
      return this.summarizerSession;
    } catch (error) {
      console.error('[AI-BRIDGE] Failed to create summarizer session:', error);
      throw error;
    }
  }

  /**
   * Summarize text content
   */
  async summarize(text, options = {}) {
    if (!this.summarizerSession) {
      await this.createSummarizerSession(options);
    }

    try {
      const summary = await this.summarizerSession.summarize(text);
      return summary;
    } catch (error) {
      console.error('[AI-BRIDGE] Failed to summarize text:', error);
      throw error;
    }
  }

  /**
   * Generate fallback structured response when AI is not available
   */
  generateStructuredResponse(query, searchResults) {
    if (!searchResults || searchResults.length === 0) {
      return `I couldn't find any relevant pages in your browsing history for "${query}". Try searching with different keywords or check if you've visited pages related to this topic.`;
    }

    const results = searchResults.slice(0, 5);
    let response = `Here's what I found in your browsing history related to "${query}":\n\n`;

    results.forEach((result, index) => {
      const title = result.title || 'Untitled';
      const url = result.url;
      const snippet = result.summary || result.snippet || result.content_text || '';
      const trimmedSnippet = snippet.length > 100 ? snippet.substring(0, 100) + '...' : snippet;

      response += `**${index + 1}. ${title}**\n`;
      response += `${url}\n`;
      if (trimmedSnippet) {
        response += `${trimmedSnippet}\n`;
      }
      response += '\n';
    });

    if (searchResults.length > 5) {
      response += `... and ${searchResults.length - 5} more results found.`;
    }

    return response;
  }

  /**
   * Cleanup sessions
   */
  async cleanup() {
    if (this.languageSession) {
      try {
        await this.languageSession.destroy();
      } catch (error) {
        console.warn('[AI-BRIDGE] Failed to cleanup language session:', error);
      }
      this.languageSession = null;
    }

    if (this.summarizerSession) {
      try {
        await this.summarizerSession.destroy();
      } catch (error) {
        console.warn('[AI-BRIDGE] Failed to cleanup summarizer session:', error);
      }
      this.summarizerSession = null;
    }
  }

  /**
   * Get current capabilities
   */
  getCapabilities() {
    return this.capabilities;
  }

  /**
   * Check if AI is ready for use
   */
  isReady() {
    return this.isInitialized && this.capabilities?.languageModel?.available === 'readily';
  }
}

// Create global instance
export const aiBridge = new AIBridge();

// For non-module usage
window.AIBridge = AIBridge;
window.aiBridge = aiBridge;