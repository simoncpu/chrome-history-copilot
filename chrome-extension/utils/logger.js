/**
 * Configurable Logger for AI History Extension
 * Provides granular log level control for production vs development
 */

const LOG_LEVEL = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

// Production default: only show warnings and errors
// Change to LOG_LEVEL.DEBUG during development for full logging
const CURRENT_LOG_LEVEL = LOG_LEVEL.DEBUG;

const logger = {
  error: (...args) => {
    // Always log errors regardless of level
    console.error(...args);
  },

  warn: (...args) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVEL.WARN) {
      console.warn(...args);
    }
  },

  info: (...args) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVEL.INFO) {
      console.log(...args);
    }
  },

  debug: (...args) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVEL.DEBUG) {
      console.log(...args);
    }
  }
};

// Helper function to change log level at runtime
logger.setLevel = (level) => {
  if (typeof level === 'string') {
    CURRENT_LOG_LEVEL = LOG_LEVEL[level.toUpperCase()] ?? LOG_LEVEL.WARN;
  } else {
    CURRENT_LOG_LEVEL = level;
  }
};

// Helper to get current log level
logger.getLevel = () => CURRENT_LOG_LEVEL;

// Export for use in other modules
export { logger, LOG_LEVEL };
