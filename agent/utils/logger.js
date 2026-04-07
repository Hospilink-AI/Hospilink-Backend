/**
 * Agent Logger Module
 * Extends backend's logger with Agent-specific functionality
 * Adds cost tracking for SearchAPI and Gemini API calls
 */

const baseLogger = require('../../src/utils/logger');

// Cost tracker for API calls
const costTracker = {
    serpApiCalls: 0,
    geminiCalls: 0,
    geminiTokens: 0,

    trackSerpApi() {
        this.serpApiCalls++;
    },

    // Alias for backward compatibility
    addSerpApiCall() {
        this.trackSerpApi();
    },

    trackGemini(tokens = 0) {
        this.geminiCalls++;
        this.geminiTokens += tokens;
    },

    // Alias for backward compatibility
    addGeminiTokens(promptTokens = 0, candidateTokens = 0) {
        this.trackGemini(promptTokens + candidateTokens);
    },

    getSummary() {
        const serpApiCost = this.serpApiCalls * 0.002; // $0.002 per call
        const geminiCost = (this.geminiTokens / 1000) * 0.00015; // $0.15 per 1M tokens (estimate)

        return {
            serpApiCalls: this.serpApiCalls,
            geminiCalls: this.geminiCalls,
            geminiTokens: this.geminiTokens,
            estimatedCost: {
                serpApi: `$${serpApiCost.toFixed(4)}`,
                gemini: `$${geminiCost.toFixed(4)}`,
                total: `$${(serpApiCost + geminiCost).toFixed(4)}`
            }
        };
    },

    reset() {
        this.serpApiCalls = 0;
        this.geminiCalls = 0;
        this.geminiTokens = 0;
    }
};

// Enhanced logger with structured logging support
const logger = {
    info: (message, meta) => {
        if (typeof message === 'object') {
            baseLogger.info(JSON.stringify(message));
        } else if (meta) {
            baseLogger.info(`${message} ${JSON.stringify(meta)}`);
        } else {
            baseLogger.info(message);
        }
    },

    error: (message, meta) => {
        if (typeof message === 'object') {
            baseLogger.error(JSON.stringify(message));
        } else if (meta) {
            baseLogger.error(`${message} ${JSON.stringify(meta)}`);
        } else {
            baseLogger.error(message);
        }
    },

    warn: (message, meta) => {
        if (typeof message === 'object') {
            baseLogger.warn(JSON.stringify(message));
        } else if (meta) {
            baseLogger.warn(`${message} ${JSON.stringify(meta)}`);
        } else {
            baseLogger.warn(message);
        }
    },

    debug: (message, meta) => {
        // Only log debug in development
        if (process.env.NODE_ENV !== 'production') {
            if (typeof message === 'object') {
                console.log(`[DEBUG] ${new Date().toISOString()} - ${JSON.stringify(message)}`);
            } else if (meta) {
                console.log(`[DEBUG] ${new Date().toISOString()} - ${message} ${JSON.stringify(meta)}`);
            } else {
                console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`);
            }
        }
    }
};

function logCostSummary() {
    const summary = costTracker.getSummary();
    logger.info('API Cost Summary', summary);
}

// Export logger as default for easier importing  
module.exports = logger;

// Also export named exports for explicit access
module.exports.logger = logger;
module.exports.costTracker = costTracker;
module.exports.logCostSummary = logCostSummary;
