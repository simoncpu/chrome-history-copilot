/**
 * Messaging Utility for Chrome Extension
 * Handles timing issues when offscreen document is still initializing
 */

/**
 * Send message to background/offscreen with automatic retry logic
 * @param {Object} message - The message to send
 * @param {Object} options - Configuration options
 * @param {number} options.maxRetries - Maximum number of retry attempts (default: 10)
 * @param {number} options.initialDelay - Initial delay in ms (default: 200)
 * @param {number} options.maxDelay - Maximum delay in ms (default: 1000)
 * @param {Function} options.shouldRetry - Function to determine if error should trigger retry
 * @returns {Promise} Response from the message handler
 */
export async function sendMessageWithRetry(message, options = {}) {
  const {
    maxRetries = 10,
    initialDelay = 200,
    maxDelay = 1000,
    shouldRetry = (error) => error.message.includes('Could not establish connection') ||
                            error.message.includes('Receiving end does not exist')
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage(message);

      // Log successful connection after retries
      if (attempt > 0) {
        console.log(`[MESSAGING] Connected after ${attempt} retries`);
      }

      return response;
    } catch (error) {
      lastError = error;

      // Check if we should retry
      if (attempt < maxRetries && shouldRetry(error)) {
        // Calculate delay with exponential backoff
        const delay = Math.min(initialDelay * Math.pow(1.5, attempt), maxDelay);

        // Log retry attempt (but not too verbose)
        if (attempt < 3 || attempt % 3 === 0) {
          console.log(`[MESSAGING] Retry ${attempt + 1}/${maxRetries + 1} in ${delay}ms...`);
        }

        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Don't retry for other errors or max retries reached
      console.error(`[MESSAGING] Failed after ${attempt + 1} attempts:`, error);
      throw error;
    }
  }

  throw lastError;
}

/**
 * Send message with shorter retry for non-critical operations
 * @param {Object} message - The message to send
 * @returns {Promise} Response or null if failed
 */
export async function sendMessageWithShortRetry(message) {
  try {
    return await sendMessageWithRetry(message, {
      maxRetries: 3,
      initialDelay: 100,
      maxDelay: 500
    });
  } catch (error) {
    console.warn('[MESSAGING] Short retry failed:', error.message);
    return null;
  }
}

/**
 * Send message for initialization/status checks
 * @param {Object} message - The message to send
 * @returns {Promise} Response from the message handler
 */
export async function sendInitMessage(message) {
  return await sendMessageWithRetry(message, {
    maxRetries: 15,
    initialDelay: 200,
    maxDelay: 1000
  });
}