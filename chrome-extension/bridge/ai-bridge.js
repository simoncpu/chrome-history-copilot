/**
 * AI History - AI Bridge Client
 * Provides a clean API for UI components to interact with Chrome's AI APIs
 * Assumes Chrome AI APIs are always available
 */

export class AIBridge {
  constructor() {
    this.languageSession = null;
    this.summarizerSession = null;
    this.capabilities = null;
    this.isInitialized = false;
  }

  /**
   * Initialize AI capabilities - assumes Chrome AI is available
   */
  async initialize() {
    if (this.isInitialized) return this.capabilities;

    // Check for Chrome 138+ global APIs first
    const hasLanguageModel = typeof LanguageModel !== 'undefined';
    const hasSummarizer = typeof Summarizer !== 'undefined';

    if (hasLanguageModel) {
      const langAvailability = await LanguageModel.availability();
      const summAvailability = hasSummarizer ? await Summarizer.availability() : 'unavailable';

      this.capabilities = {
        languageModel: {
          available: langAvailability,
          ready: langAvailability === 'available'
        },
        summarizer: hasSummarizer ? {
          available: summAvailability,
          ready: summAvailability === 'available'
        } : null
      };
      console.log('[AI-BRIDGE] Chrome 138+ APIs initialized:', langAvailability, summAvailability);
    } else if (window.ai?.languageModel) {
      // Handle legacy window.ai
      this.capabilities = {
        languageModel: window.ai.languageModel ?
          await window.ai.languageModel.capabilities() : null,
        summarizer: window.ai.summarizer ?
          await window.ai.summarizer.capabilities() : null
      };
      console.log('[AI-BRIDGE] Legacy window.ai APIs initialized');
    } else {
      throw new Error('Chrome AI APIs not available - ensure Chrome Canary with AI flags enabled');
    }

    this.isInitialized = true;
    return this.capabilities;
  }

  /**
   * Check if language model is available
   */
  async isLanguageModelAvailable() {
    await this.initialize();
    return this.capabilities?.languageModel?.ready ||
           this.capabilities?.languageModel?.available === 'readily' ||
           this.capabilities?.languageModel?.available === 'available' ||
           this.capabilities?.languageModel?.available === 'downloadable';
  }

  /**
   * Check if summarizer is available
   */
  async isSummarizerAvailable() {
    await this.initialize();
    return this.capabilities?.summarizer?.ready ||
           this.capabilities?.summarizer?.available === 'readily' ||
           this.capabilities?.summarizer?.available === 'available' ||
           this.capabilities?.summarizer?.available === 'downloadable';
  }

  /**
   * Create a language model session
   */
  async createLanguageSession(options = {}) {
    await this.initialize();

    const sessionOptions = {
      initialPrompts: [{
        role: 'system',
        content: options.systemPrompt || this.getDefaultSystemPrompt()
      }],
      temperature: options.temperature || 0.7,
      topK: options.topK || 3,
      language: options.language || 'en'
      // outputLanguage: options.outputLanguage || 'en'  // Commented out for testing
    };

    // Use global LanguageModel for Chrome 138+
    if (typeof LanguageModel !== 'undefined') {
      const availability = await LanguageModel.availability();
      if (availability !== 'available' && availability !== 'downloadable') {
        throw new Error(`Language model not available: ${availability}`);
      }
      console.log('[AI-BRIDGE] Creating session with Chrome 138+ LanguageModel API');
      this.languageSession = await LanguageModel.create(sessionOptions);
    } else if (window.ai?.languageModel) {
      // Handle legacy API with adapted options
      const legacyOptions = {
        systemPrompt: options.systemPrompt || this.getDefaultSystemPrompt(),
        temperature: options.temperature || 0.7,
        topK: options.topK || 3,
        language: options.language || 'en',
        // outputLanguage: options.outputLanguage || 'en',  // Commented out for testing
        ...options
      };
      console.log('[AI-BRIDGE] Creating session with legacy window.ai API');
      this.languageSession = await window.ai.languageModel.create(legacyOptions);
    } else {
      throw new Error('Chrome AI LanguageModel API not available');
    }

    return this.languageSession;
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

    const sessionOptions = {
      type: options.type || 'tl;dr',
      format: options.format || 'markdown',
      length: options.length || 'short',
      ...options
    };

    // Use global Summarizer for Chrome 138+
    if (typeof Summarizer !== 'undefined') {
      const availability = await Summarizer.availability();
      if (availability !== 'available' && availability !== 'downloadable') {
        throw new Error(`Summarizer not available: ${availability}`);
      }
      console.log('[AI-BRIDGE] Creating summarizer session with Chrome 138+ API');
      this.summarizerSession = await Summarizer.create(sessionOptions);
    } else if (window.ai?.summarizer) {
      // Handle legacy API
      console.log('[AI-BRIDGE] Creating summarizer session with legacy window.ai API');
      this.summarizerSession = await window.ai.summarizer.create(sessionOptions);
    } else {
      throw new Error('Chrome AI Summarizer API not available');
    }

    return this.summarizerSession;
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
    return this.isInitialized && (
      this.capabilities?.languageModel?.ready ||
      this.capabilities?.languageModel?.available === 'readily' ||
      this.capabilities?.languageModel?.available === 'available' ||
      this.capabilities?.languageModel?.available === 'downloadable'
    );
  }
}

// Create global instance
export const aiBridge = new AIBridge();

// For non-module usage
window.AIBridge = AIBridge;
window.aiBridge = aiBridge;
