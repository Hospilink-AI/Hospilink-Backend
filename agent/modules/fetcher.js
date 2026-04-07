/**
 * Fetcher Module - Simple HTTP fetch (replaces crawler)
 * Single-page fetch only, no recursion, no JS rendering.
 * Skip on failure without retry.
 * 
 * CONVERTED TO COMMONJS for backend compatibility
 */
const axios = require('axios');
const cheerio = require('cheerio');
const { logger } = require('../utils/logger');

// User agent to mimic browser
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Fetch timeout (shorter than crawler - no retry needed)
const FETCH_TIMEOUT = 15000;

// Max content size (5MB)
const MAX_CONTENT_SIZE = 5 * 1024 * 1024;

/**
 * Fetch a single URL and extract text content
 * @param {string} url - URL to fetch
 * @returns {Promise<Object|null>} { url, html, text, success } or null on failure
 */
async function fetchPage(url) {
    try {
        const response = await axios.get(url, {
            timeout: FETCH_TIMEOUT,
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1'
            },
            maxContentLength: MAX_CONTENT_SIZE,
            maxRedirects: 3,
            validateStatus: (status) => status >= 200 && status < 400
        });

        // Check content type
        const contentType = (response.headers['content-type'] || '').toLowerCase();

        // Explicitly reject known binary types
        if (contentType.includes('application/pdf') ||
            contentType.includes('image/') ||
            contentType.includes('audio/') ||
            contentType.includes('video/') ||
            contentType.includes('application/zip') ||
            contentType.includes('application/octet-stream')) {
            logger.debug(`Skipping binary content: ${url}`, { contentType });
            return null;
        }

        // Must be text-based
        if (!contentType.includes('text/html') &&
            !contentType.includes('text/plain') &&
            !contentType.includes('application/xhtml+xml') &&
            !contentType.includes('application/xml') &&
            !contentType.includes('application/json')) {
            logger.debug(`Skipping non-text content: ${url}`, { contentType });
            return null;
        }

        const html = response.data;
        const text = extractTextFromHtml(html);

        logger.debug(`Fetched: ${url}`, {
            htmlSize: html.length,
            textSize: text.length
        });

        return {
            url,
            html,
            text,
            success: true
        };

    } catch (error) {
        // Log and skip - no retry
        const status = error.response?.status;
        const reason = status
            ? `HTTP ${status}`
            : (error.code === 'ECONNABORTED' ? 'Timeout' : error.message);

        logger.debug(`Fetch failed: ${url}`, { reason });

        return null;
    }
}

/**
 * Extract clean text from HTML
 * @param {string} html - Raw HTML
 * @returns {string} Cleaned text (max 50000 chars for LLM)
 */
function extractTextFromHtml(html) {
    try {
        const $ = cheerio.load(html);

        // Remove non-content elements
        $('script, style, nav, header, footer, aside, .cookie, .popup, .modal, .advertisement, .ad').remove();

        // Get text from body
        let text = $('body').text() || $.root().text();

        // Clean up whitespace
        text = text
            .replace(/\s+/g, ' ')
            .replace(/\n\s*\n/g, '\n')
            .trim();

        // Limit size for LLM processing
        return text.slice(0, 50000);

    } catch (error) {
        // Fallback: strip HTML tags
        return html
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 50000);
    }
}

/**
 * Fetch multiple URLs in parallel with concurrency limit
 * @param {Object[]} urls - Array of { url, ... } objects
 * @param {number} concurrency - Max concurrent fetches (default: 5)
 * @returns {Promise<Object[]>} Array of successful fetch results
 */
async function fetchBatch(urls, concurrency = 5) {
    logger.info(`Fetching ${urls.length} URLs (concurrency: ${concurrency})`);

    const results = [];

    // Process in chunks for concurrency control
    for (let i = 0; i < urls.length; i += concurrency) {
        const chunk = urls.slice(i, i + concurrency);

        const chunkResults = await Promise.all(
            chunk.map(item => fetchPage(item.url || item))
        );

        // Filter out failures and add to results
        for (let j = 0; j < chunkResults.length; j++) {
            if (chunkResults[j]) {
                // Merge original SERP data with fetch result
                results.push({
                    ...chunk[j],
                    ...chunkResults[j]
                });
            }
        }
    }

    logger.info(`Fetch completed`, {
        attempted: urls.length,
        successful: results.length,
        failed: urls.length - results.length
    });

    return results;
}

module.exports = {
    fetchPage,
    fetchBatch,
    extractTextFromHtml
};