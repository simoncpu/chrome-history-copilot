/**
 * Chrome AI Availability Loader
 * Handles waiting for Chrome AI APIs to become available with exponential backoff
 */

export class ChromeAILoader {
  constructor() {
    this.maxWaitTime = 30000; // 30 seconds max wait
    this.baseDelay = 100; // Start with 100ms
    this.maxDelay = 2000; // Max 2 seconds between checks
    this.backoffFactor = 1.5; // Exponential backoff multiplier
  }

  /**
   * Wait for Chrome AI APIs to become available with exponential backoff
   * @param {Function} onProgress - Progress callback (optional)
   * @returns {Promise<Object>} - Resolves with API info when available
   */
  async waitForChromeAI(onProgress = null) {
    const startTime = Date.now();
    let currentDelay = this.baseDelay;
    let attempt = 0;

    console.log('[CHROME-AI-LOADER] Waiting for Chrome AI APIs to become available...');

    if (onProgress) {
      onProgress('Waiting for Chrome AI APIs to load...');
    }

    while (Date.now() - startTime < this.maxWaitTime) {
      attempt++;

      try {
        const apiInfo = await this.checkChromeAIAvailability();
        if (apiInfo.available) {
          console.log(`[CHROME-AI-LOADER] ✅ Chrome AI APIs available after ${attempt} attempts in ${Date.now() - startTime}ms`);
          if (onProgress) {
            onProgress('Chrome AI APIs loaded successfully!');
          }
          return apiInfo;
        }

        // APIs not ready yet, wait before next check
        console.log(`[CHROME-AI-LOADER] Attempt ${attempt}: APIs not ready (${apiInfo.reason}), waiting ${currentDelay}ms...`);

        if (onProgress) {
          onProgress(`Attempt ${attempt}: Waiting for Chrome AI APIs... (${apiInfo.reason})`);
        }

        await this.sleep(currentDelay);

        // Exponential backoff with max limit
        currentDelay = Math.min(currentDelay * this.backoffFactor, this.maxDelay);

      } catch (error) {
        console.warn(`[CHROME-AI-LOADER] Attempt ${attempt} failed:`, error.message);

        if (onProgress) {
          onProgress(`Attempt ${attempt}: Checking Chrome AI APIs...`);
        }

        await this.sleep(currentDelay);
        currentDelay = Math.min(currentDelay * this.backoffFactor, this.maxDelay);
      }
    }

    // Timeout reached
    const finalError = new Error(`Chrome AI APIs did not become available within ${this.maxWaitTime}ms. Please ensure you are using Chrome Canary with AI flags enabled: --enable-features=LanguageModel,LanguageModelExperimental,AITextModelExperimental`);
    console.error('[CHROME-AI-LOADER]', finalError.message);

    if (onProgress) {
      onProgress('❌ Chrome AI APIs failed to load');
    }

    throw finalError;
  }

  /**
   * Check current Chrome AI API availability
   * @returns {Promise<Object>} - API availability info
   */
  async checkChromeAIAvailability() {
    // Chrome AI APIs are always available, just need time to load
    if (typeof LanguageModel === 'undefined') {
      return {
        available: false,
        reason: 'LanguageModel global not yet defined - Chrome AI still loading',
        version: 'chrome-138+',
        api: 'global'
      };
    }

    try {
      const langAvailability = await LanguageModel.availability();

      if (langAvailability === 'available') {
        // Check Summarizer as well
        const summarizerAvailable = typeof Summarizer !== 'undefined' ?
          await Summarizer.availability() === 'available' : false;

        return {
          available: true,
          version: 'chrome-138+',
          api: 'global',
          languageModel: true,
          summarizer: summarizerAvailable
        };
      } else {
        return {
          available: false,
          reason: `LanguageModel status: ${langAvailability}`,
          version: 'chrome-138+',
          api: 'global'
        };
      }
    } catch (error) {
      return {
        available: false,
        reason: `LanguageModel error: ${error.message}`,
        version: 'chrome-138+',
        api: 'global'
      };
    }
  }

  /**
   * Sleep for specified milliseconds
   * @param {number} ms - Milliseconds to sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Quick availability check without waiting
   * @returns {Promise<boolean>} - True if APIs are immediately available
   */
  async isImmediatelyAvailable() {
    try {
      const apiInfo = await this.checkChromeAIAvailability();
      return apiInfo.available;
    } catch {
      return false;
    }
  }
}

// Create global instance
export const chromeAILoader = new ChromeAILoader();

// For non-module usage
window.ChromeAILoader = ChromeAILoader;
window.chromeAILoader = chromeAILoader;