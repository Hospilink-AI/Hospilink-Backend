/**
 * SerpAPI Search Module - serpapi.com integration for job search
 * Returns the same { url, title, snippet, metadata } shape as search.js
 */
const axios = require('axios');
const config = require('../utils/config');
const { logger } = require('../utils/logger');

const SERPAPI_ENDPOINT = 'https://serpapi.com/search';

/**
 * Run a single query against SerpAPI
 * @param {string} query
 * @returns {Promise<Object[]>} Array of { url, title, snippet, metadata }
 */
async function searchSerper(query) {
    if (!config.serperApiKey) return [];

    try {
        const response = await axios.get(SERPAPI_ENDPOINT, {
            params: {
                q: query,
                api_key: config.serperApiKey,
                engine: 'google',
                gl: config.searchApi.location,
                hl: config.searchApi.language,
                num: config.searchApi.numResults
            },
            timeout: config.searchApi.timeout
        });

        const organic = response.data.organic_results || [];

        logger.info(`SerpAPI search completed for: "${query}"`, {
            resultsCount: organic.length
        });

        return organic.map(result => ({
            url: result.link,
            title: result.title,
            snippet: result.snippet || '',
            metadata: {
                displayed_link: result.displayed_link,
                source: 'serpapi',
                date: result.date
            }
        })).filter(r => r.url);

    } catch (error) {
        logger.warn(`SerpAPI search failed for: "${query}"`, { error: error.message });
        return [];
    }
}

/**
 * Run all queries in parallel via SerpAPI
 * @param {string[]} queries
 * @returns {Promise<Object[]>} Deduplicated results
 */
async function searchAllSerper(queries) {
    if (!config.serperApiKey) {
        logger.debug('SerpAPI skipped — SERPER_API_KEY not set');
        return [];
    }

    const results = await Promise.all(queries.map(q => searchSerper(q)));

    // Flatten and deduplicate by URL
    const urlMap = new Map();
    for (const resultSet of results) {
        for (const result of resultSet) {
            if (!urlMap.has(result.url)) {
                urlMap.set(result.url, result);
            }
        }
    }

    return Array.from(urlMap.values());
}

module.exports = { searchAllSerper };
