/**
 * AI History - Database Bridge Client
 * Provides a clean API for UI components to interact with the offscreen database
 */

export class DatabaseBridge {
  constructor() {
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.isConnected = false;

    // Set up message listener for responses
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'db-response' && message.requestId) {
        this.handleResponse(message);
      }
    });
  }

  /**
   * Generate unique request ID
   */
  generateRequestId() {
    return `db-${++this.requestId}-${Date.now()}`;
  }

  /**
   * Send request to offscreen document
   */
  async sendRequest(type, data = {}) {
    const requestId = this.generateRequestId();

    return new Promise((resolve, reject) => {
      // Store request for response handling
      this.pendingRequests.set(requestId, { resolve, reject });

      // Send message to offscreen
      chrome.runtime.sendMessage({
        target: 'offscreen',
        type: type,
        data: data,
        requestId: requestId
      }).catch(error => {
        this.pendingRequests.delete(requestId);
        reject(error);
      });

      // Set timeout for request
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 30000); // 30 second timeout
    });
  }

  /**
   * Handle response from offscreen document
   */
  handleResponse(message) {
    const request = this.pendingRequests.get(message.requestId);
    if (!request) return;

    this.pendingRequests.delete(message.requestId);

    if (message.error) {
      request.reject(new Error(message.error));
    } else {
      request.resolve(message.data || message);
    }
  }

  /**
   * Test connection to offscreen document
   */
  async ping() {
    try {
      const response = await this.sendRequest('ping');
      this.isConnected = response.status === 'ok';
      return this.isConnected;
    } catch (error) {
      this.isConnected = false;
      throw error;
    }
  }

  /**
   * Initialize the database
   */
  async initialize() {
    return await this.sendRequest('init');
  }

  /**
   * Search the database
   */
  async search(query, options = {}) {
    const searchParams = {
      query: query,
      mode: options.mode || 'hybrid-rerank',
      limit: options.limit || 25,
      offset: options.offset || 0
    };

    const response = await this.sendRequest('search', searchParams);
    return response.results || [];
  }

  /**
   * Ingest a page into the database
   */
  async ingestPage(pageInfo) {
    return await this.sendRequest('ingest-page', pageInfo);
  }

  /**
   * Generate embeddings for text
   */
  async embed(text) {
    const response = await this.sendRequest('embed', { text });
    return response.embeddings;
  }

  /**
   * Get database statistics
   */
  async getStats() {
    return await this.sendRequest('get-stats');
  }

  /**
   * Execute raw SQL query (for debug page)
   */
  async executeSQL(query, writeMode = false) {
    return await this.sendRequest('execute-sql', { query, writeMode });
  }

  /**
   * Clear the entire database
   */
  async clearDatabase() {
    return await this.sendRequest('clear-db');
  }

  /**
   * Export database
   */
  async exportDatabase() {
    return await this.sendRequest('export-db');
  }

  /**
   * Import database
   */
  async importDatabase(data, filename) {
    return await this.sendRequest('import-db', { data, filename });
  }

  /**
   * Clear model cache
   */
  async clearModelCache() {
    return await this.sendRequest('clear-model-cache');
  }

  /**
   * Get connection status
   */
  getConnectionStatus() {
    return this.isConnected;
  }

  /**
   * Cleanup pending requests
   */
  cleanup() {
    for (const [requestId, request] of this.pendingRequests) {
      request.reject(new Error('Bridge cleanup'));
    }
    this.pendingRequests.clear();
  }
}

// Create global instance
export const dbBridge = new DatabaseBridge();

// For non-module usage
window.DatabaseBridge = DatabaseBridge;
window.dbBridge = dbBridge;