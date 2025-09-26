/**
 * AI History - AI Bridge Client
 * Provides a clean API for UI components to interact with Chrome's AI APIs
 * Assumes Chrome AI APIs are always available
 */

import { chromeAILoader } from './chrome-ai-loader.js';

export class AIBridge {
  constructor() {
    this.languageSession = null;
    this.summarizerSession = null;
    this.capabilities = null;
    this.isInitialized = false;
  }

  /**
   * Initialize AI capabilities - waits for Chrome AI to load
   */
  async initialize(onProgress = null) {
    if (this.isInitialized) return this.capabilities;

    // Wait for Chrome AI APIs to become available
    const apiInfo = await chromeAILoader.waitForChromeAI(onProgress);
    console.log('[AI-BRIDGE] Chrome AI APIs loaded:', apiInfo);

    const langAvailability = await LanguageModel.availability();
    const summAvailability = typeof Summarizer !== 'undefined' ? await Summarizer.availability() : 'unavailable';

    // Get default parameters for Chrome 138+
    let defaultParams = {};
    try {
      defaultParams = await LanguageModel.params();
    } catch (e) {
      console.warn('[AI-BRIDGE] Could not get default parameters:', e);
    }

    this.capabilities = {
      languageModel: {
        available: langAvailability,
        ready: langAvailability === 'available',
        downloadable: langAvailability === 'downloadable',
        downloading: langAvailability === 'downloading',
        params: defaultParams
      },
      summarizer: typeof Summarizer !== 'undefined' ? {
        available: summAvailability,
        ready: summAvailability === 'available',
        downloadable: summAvailability === 'downloadable',
        downloading: summAvailability === 'downloading'
      } : null
    };
    console.log('[AI-BRIDGE] Chrome AI APIs initialized:', langAvailability, summAvailability);

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
   * Create a language model session with proper initialPrompts support
   */
  async createLanguageSession(options = {}) {
    await this.initialize();

    const params = this.capabilities?.languageModel?.params || {};
    const sessionOptions = {
      initialPrompts: options.initialPrompts || [{
        role: 'system',
        content: options.systemPrompt || this.getDefaultSystemPrompt()
      }],
      temperature: options.temperature || params.defaultTemperature || 0.7,
      topK: options.topK || params.defaultTopK || 3
    };

    // Add monitor for download progress if requested
    if (options.showProgress) {
      sessionOptions.monitor = (m) => {
        m.addEventListener('downloadprogress', (e) => {
          console.log(`[AI-BRIDGE] Model download progress: ${Math.round(e.loaded * 100)}%`);
          if (options.onProgress) {
            options.onProgress(e.loaded);
          }
        });
      };
    }

    // Use global LanguageModel for Chrome 138+
    if (typeof LanguageModel !== 'undefined') {
      const availability = await LanguageModel.availability();
      if (availability === 'unavailable') {
        throw new Error(`Language model not available: ${availability}`);
      }
      console.log('[AI-BRIDGE] Creating session with Chrome 138+ LanguageModel API');
      this.languageSession = await LanguageModel.create(sessionOptions);
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
2. Keep responses brief and concise
3. If no relevant information is found, say so clearly

Format guidelines:
- Use **bold** for emphasis
- Be direct and actionable

Remember: You can only reference information from the provided browsing history context.`;
  }

  /**
   * Add context to the current session using append()
   */
  async appendContext(context) {
    if (!this.languageSession) {
      throw new Error('No active language session. Create session first.');
    }

    const contextMessage = {
      role: 'system',
      content: context
    };

    try {
      await this.languageSession.append([contextMessage]);
    } catch (error) {
      console.error('[AI-BRIDGE] Failed to append context:', error);
      throw error;
    }
  }

  /**
   * Generate a response using the language model with context appending
   */
  async generateResponse(prompt, context = '') {
    if (!this.languageSession) {
      await this.createLanguageSession();
    }

    // Append context if provided
    if (context) {
      await this.appendContext(`Context from browsing history:\n${context}`);
    }

    try {
      const response = await this.languageSession.prompt(prompt);
      return response;
    } catch (error) {
      console.error('[AI-BRIDGE] Failed to generate response:', error);
      throw error;
    }
  }

  /**
   * Generate a streaming response with context appending
   */
  async generateStreamingResponse(prompt, context = '', onChunk = null) {
    if (!this.languageSession) {
      await this.createLanguageSession();
    }

    // Append context if provided
    if (context) {
      await this.appendContext(`Context from browsing history:\n${context}`);
    }

    try {
      const stream = await this.languageSession.promptStreaming(prompt);
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

    return results.map((result) => {
      const title = result.title || 'Untitled';
      const url = result.url;
      const content = result.summary || result.snippet || result.content_text || '';
      const trimmedContent = content.length > 200 ? content.substring(0, 200) + '...' : content;

      return `Title: **${title}**
   Content: ${trimmedContent}`;
    }).join('\n\n');
  }

  /**
   * Create a summarizer session with Chrome 138+ API support
   */
  async createSummarizerSession(options = {}) {
    await this.initialize();

    const sessionOptions = {
      type: options.type || 'tldr', // Fixed typo: 'tl;dr' -> 'tldr'
      format: options.format || 'markdown',
      length: options.length || 'short'
    };

    // Add monitor for download progress if requested
    if (options.showProgress) {
      sessionOptions.monitor = (m) => {
        m.addEventListener('downloadprogress', (e) => {
          console.log(`[AI-BRIDGE] Summarizer download progress: ${Math.round(e.loaded * 100)}%`);
          if (options.onProgress) {
            options.onProgress(e.loaded);
          }
        });
      };
    }

    // Use global Summarizer for Chrome 138+
    if (typeof Summarizer !== 'undefined') {
      const availability = await Summarizer.availability();
      if (availability === 'unavailable') {
        throw new Error(`Summarizer not available: ${availability}`);
      }
      console.log('[AI-BRIDGE] Creating summarizer session with Chrome 138+ API');
      this.summarizerSession = await Summarizer.create(sessionOptions);
    } else {
      throw new Error('Chrome AI Summarizer API not available');
    }

    return this.summarizerSession;
  }

  /**
   * Summarize text content with context support
   */
  async summarize(text, options = {}) {
    if (!this.summarizerSession) {
      await this.createSummarizerSession(options);
    }

    try {
      // Use context parameter if provided for better summaries
      const summarizeOptions = {};
      if (options.context) {
        summarizeOptions.context = options.context;
      }

      const summary = await this.summarizerSession.summarize(text, summarizeOptions);
      return summary;
    } catch (error) {
      console.error('[AI-BRIDGE] Failed to summarize text:', error);
      throw error;
    }
  }

  /**
   * Streaming summarization
   */
  async summarizeStreaming(text, options = {}, onChunk = null) {
    if (!this.summarizerSession) {
      await this.createSummarizerSession(options);
    }

    try {
      const summarizeOptions = {};
      if (options.context) {
        summarizeOptions.context = options.context;
      }

      const stream = await this.summarizerSession.summarizeStreaming(text, summarizeOptions);
      let fullSummary = '';

      for await (const chunk of stream) {
        fullSummary = chunk;
        if (onChunk) {
          onChunk(chunk);
        }
      }

      return fullSummary;
    } catch (error) {
      console.error('[AI-BRIDGE] Failed to stream summarize text:', error);
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
   * Get session quota information
   */
  getSessionQuota() {
    if (!this.languageSession) {
      return null;
    }

    try {
      return {
        inputUsage: this.languageSession.inputUsage || 0,
        inputQuota: this.languageSession.inputQuota || 0,
        usagePercent: this.languageSession.inputQuota ?
          Math.round((this.languageSession.inputUsage / this.languageSession.inputQuota) * 100) : 0
      };
    } catch (error) {
      console.warn('[AI-BRIDGE] Could not get session quota:', error);
      return null;
    }
  }

  /**
   * Check if AI is ready for use
   */
  isReady() {
    return this.isInitialized && (
      this.capabilities?.languageModel?.ready ||
      this.capabilities?.languageModel?.available === 'readily' ||
      this.capabilities?.languageModel?.available === 'available' ||
      this.capabilities?.languageModel?.downloadable ||
      this.capabilities?.languageModel?.available === 'downloadable'
    );
  }
}

// Create global instance
export const aiBridge = new AIBridge();

// For non-module usage
window.AIBridge = AIBridge;
window.aiBridge = aiBridge;
