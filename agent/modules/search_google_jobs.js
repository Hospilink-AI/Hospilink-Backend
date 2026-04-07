/**
 * CONVERTED TO COMMONJS for backend compatibility
 */
/**
 * Google Jobs Search Module - SearchAPI integration
 * 
 * Searches the 'google_jobs' engine for structured job listings.
 * These results are high volume but low "direct contact" signal.
 * They serve as excellent candidates for enrichment.
 */
const axios = require('axios');
const config = require('../utils/config');
const logger = require('../utils/logger');
const { costTracker } = require('../utils/logger');

/**
 * Search Google Jobs via SearchApi
 * @param {string} role - Job role
 * @param {string} location - Location
 * @returns {Promise<Object[]>} Array of mapped Job objects
 */
async function searchGoogleJobs(role, location) {
    if (!config.enableGoogleJobs) {
        return [];
    }

    const query = `${role} jobs in ${location}`;
    logger.info(`Starting Google Jobs search for: "${query}"`);

    const allJobs = [];
    const maxLimit = config.googleJobsLimit || 300;
    const maxPages = config.googleJobsMaxPages || 10;
    let pageToken = null;
    let pageCount = 0;

    try {
        do {
            pageCount++;
            const params = {
                q: query,
                api_key: config.searchApiKey,
                engine: 'google_jobs',
                gl: config.searchApi.location,
                hl: config.searchApi.language,
                num: 100 // Request max per page if possible (though Google Jobs usually returns ~10-20)
            };

            if (pageToken) {
                params.next_page_token = pageToken;
            }

            logger.info(`Fetching Google Jobs page ${pageCount}...`);
            const response = await axios.get('https://www.searchapi.io/api/v1/search', {
                params,
                timeout: config.searchApi.timeout + 10000 // Slightly longer for jobs engine
            });

            costTracker.addSerpApiCall();

            const jobs = response.data.jobs || response.data.jobs_results || [];
            if (jobs.length === 0) {
                break;
            }

            allJobs.push(...jobs);

            // Check for next page
            pageToken = response.data.pagination?.next_page_token;

            // Stop if we reached our limit or no more pages
            if (allJobs.length >= maxLimit) {
                logger.info(`Reached job limit (${maxLimit})`);
                break;
            }

        } while (pageToken && pageCount < maxPages);

        logger.info(`Google Jobs search completed. Found ${allJobs.length} jobs across ${pageCount} pages.`);
        return allJobs.slice(0, maxLimit)
            .map(mapGoogleJobToInternal)
            .filter(job => job !== null);

    } catch (error) {
        logger.error('Google Jobs search failed', { error: error.message });
        // Return whatever we managed to collect so far
        return allJobs
            .map(mapGoogleJobToInternal)
            .filter(job => job !== null); // Filter out skipped jobs (PDFs, etc)
    }
}

// URL patterns that are NOT real job apply links
const BAD_LINK_PATTERNS = [
    'google.com/search', 'google.co.in/search',
    'google.com/webhp', 'google.co.in/webhp',
    'google.com/about', 'google.co.in/about',
    'google.com/?', 'google.co.in/?',
    'threads.net', 'instagram.com', 'twitter.com', 'x.com/search',
    'facebook.com/groups', 'reddit.com',
    'wa.me', 'api.whatsapp.com',
];

const IGNORED_EXTS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];

function isValidApplyUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    if (BAD_LINK_PATTERNS.some(p => lower.includes(p))) return false;
    let decoded = lower;
    try { decoded = decodeURIComponent(lower); } catch (e) { /* ignore */ }
    if (IGNORED_EXTS.some(ext => decoded.endsWith(ext) || decoded.includes(ext + '?'))) return false;
    return true;
}

/**
 * Map SearchApi Google Job result to internal Job schema
 * @param {Object} gJob - Google Job result object
 * @returns {Object} Internal Job object
 */
function mapGoogleJobToInternal(gJob) {
    // 1. Better Link Selection - prefer real external job URLs over Google links
    const applyOptions = gJob.apply_links || gJob.apply_options || [];
    let applyLink = null;

    // Filter out Google, social media, and binary file links
    const externalLinks = applyOptions.filter(opt => isValidApplyUrl(opt.link || ''));

    if (externalLinks.length > 0) {
        // Pick the first valid external link (e.g., LinkedIn, Naukri, Company Site)
        applyLink = externalLinks[0].link;
        logger.debug(`Selected external link for '${gJob.title}': ${applyLink}`);
    } else if (applyOptions.length > 0) {
        // Fallback to first available if nothing better
        const firstLink = applyOptions[0].link;
        if (isValidApplyUrl(firstLink)) {
            applyLink = firstLink;
        }
    }

    // Fallback to share link only if it's a valid external URL
    if (!applyLink) {
        const shareLink = gJob.sharing_link || gJob.share_link;
        if (isValidApplyUrl(shareLink)) {
            applyLink = shareLink;
        }
    }

    // 2. PDF/Binary Filter (final safety check)
    if (applyLink && !isValidApplyUrl(applyLink)) {
        logger.debug(`Dropping invalid apply link for '${gJob.title}': ${applyLink}`);
        applyLink = null;
    }

    // Detect if we can find any email in description (simple regex)
    const emailMatch = gJob.description ? gJob.description.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/) : null;
    const phoneMatch = gJob.description ? gJob.description.match(/(\+91[-\s]?)?[6-9]\d{9}/) : null;

    const emails = emailMatch ? [emailMatch[0]] : [];
    const phones = phoneMatch ? [phoneMatch[0]] : [];

    return {
        role: gJob.title,
        company_name: gJob.company_name,
        hospital_name: gJob.company_name, // Map company to hospital_name for consistency
        location: gJob.location,
        job_description: gJob.description, // Full description for LLM to process later
        posted_date: gJob.detected_extensions?.posted_at,
        source_url: applyLink || (isValidApplyUrl(gJob.sharing_link) ? gJob.sharing_link : null),
        apply_link: applyLink,

        // Contact Info (will be enriched by LLM later)
        emails: emails,
        phones: phones,

        // Metadata
        via: gJob.via,
        extensions: gJob.extensions,

        // Status
        confidence_score: 80,
        outreach_status: 'partial', // Mark as partial so it goes through standardized extraction if needed
        validated: true,

        // Flags
        is_google_jobs: true
    };
}

module.exports = searchGoogleJobs;