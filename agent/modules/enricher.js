/**
 * CONVERTED TO COMMONJS for backend compatibility
 */
/**
 * Enricher Module - Reverse enrichment to fill missing contact info
 * 
 * Strategy: hospital_name → website → /careers or /contact → extract email/phone
 * Can fill missing emails on ~50% of cases.
 */
const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../utils/logger');

// Common career/contact page paths to try
const CONTACT_PATHS = [
    '/careers',
    '/careers.html',
    '/careers.php',
    '/career',
    '/jobs',
    '/contact',
    '/contact-us',
    '/contactus',
    '/about/contact'
];

// Contact extraction patterns
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_PATTERN = /(?:\+91[-\s]?)?[6-9]\d{9}|\d{2,4}[-\s]?\d{6,8}/g;

// Domain extraction from hospital name
const HOSPITAL_DOMAIN_SUFFIXES = [
    '.com',
    '.in',
    '.org',
    '.co.in',
    '.org.in',
    '.edu.in'
];

/**
 * Try to guess hospital website from name
 * @param {string} hospitalName - Hospital name
 * @returns {string[]} Possible website URLs
 */
function guessWebsiteFromName(hospitalName) {
    if (!hospitalName) return [];

    // Clean name for domain generation
    const cleaned = hospitalName
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, '')
        .replace(/hospital|clinic|healthcare|medical|centre|center|pvt|ltd|private|limited/gi, '')
        .trim();

    if (cleaned.length < 3) return [];

    // Generate possible domains
    const possibleUrls = [];

    for (const suffix of HOSPITAL_DOMAIN_SUFFIXES) {
        possibleUrls.push(`https://${cleaned}${suffix}`);
        possibleUrls.push(`https://www.${cleaned}${suffix}`);

        // Try with "hospital" suffix
        possibleUrls.push(`https://${cleaned}hospital${suffix}`);
    }

    return possibleUrls.slice(0, 8); // Limit attempts
}

/**
 * Extract contacts from HTML
 * @param {string} html - Page HTML
 * @returns {Object} { emails: [], phones: [] }
 */
function extractContactsFromHtml(html) {
    if (!html) return { emails: [], phones: [] };

    // Get text content
    const $ = cheerio.load(html);
    const text = $('body').text() || html;

    // Extract emails
    const emailMatches = text.match(EMAIL_PATTERN) || [];
    const emails = [...new Set(emailMatches)]
        .filter(e =>
            !e.includes('example.com') &&
            !e.includes('domain.com') &&
            !e.includes('sentry.io') &&
            !e.includes('google.com')
        )
        .slice(0, 5);

    // Extract phones
    const phoneMatches = text.match(PHONE_PATTERN) || [];
    const phones = [...new Set(phoneMatches)]
        .map(p => {
            const digits = p.replace(/\D/g, '').slice(-10);
            if (digits.length === 10 && /^[6-9]/.test(digits)) {
                return `+91-${digits.slice(0, 3)}-${digits.slice(3)}`;
            }
            return null;
        })
        .filter(Boolean)
        .slice(0, 5);

    return { emails, phones };
}

/**
 * Try to fetch a URL with timeout
 * @param {string} url - URL to fetch
 * @returns {Promise<string|null>} HTML or null
 */
async function tryFetch(url) {
    try {
        const response = await axios.get(url, {
            timeout: 4000,
            maxRedirects: 2,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; JobFinder/2.0)',
                'Accept': 'text/html'
            },
            validateStatus: s => s >= 200 && s < 400
        });
        return response.data;
    } catch (e) {
        return null;
    }
}

/**
 * Enrich a single job with missing contact info
 * @param {Object} job - Job object with hospital_name
 * @returns {Promise<Object>} Enriched job
 */
async function enrichJob(job) {
    // Skip if already has good contacts
    const hasEmail = job.emails && job.emails.length > 0;
    const hasPhone = job.phones && job.phones.length > 0;

    if (hasEmail && hasPhone) {
        return job; // Already complete
    }

    // Try to find hospital website
    let baseUrl = null;

    // Option 1: Extract from source_url or apply_link
    const existingUrl = job.source_url || job.apply_link;
    if (existingUrl) {
        try {
            const parsed = new URL(existingUrl);
            baseUrl = `${parsed.protocol}//${parsed.hostname}`;
        } catch (e) {
            // Invalid URL
        }
    }

    // Option 2: Guess from hospital name
    const guessedUrls = guessWebsiteFromName(job.hospital_name);

    // Try career/contact pages
    const urlsToTry = [];

    if (baseUrl) {
        for (const path of CONTACT_PATHS) {
            urlsToTry.push(baseUrl + path);
        }
    }

    // Add guessed URLs (just home pages)
    urlsToTry.push(...guessedUrls);

    // Limit total attempts
    const limitedUrls = urlsToTry.slice(0, 6);

    logger.debug(`Enriching: ${job.hospital_name}`, {
        urlsToTry: limitedUrls.length
    });

    // Try URLs in parallel (max 3 concurrent)
    for (let i = 0; i < limitedUrls.length; i += 3) {
        const batch = limitedUrls.slice(i, i + 3);
        const results = await Promise.all(batch.map(tryFetch));

        for (const html of results) {
            if (html) {
                const contacts = extractContactsFromHtml(html);

                // Fill missing emails
                if (!hasEmail && contacts.emails.length > 0) {
                    job.emails = contacts.emails;
                    job.enriched_emails = true;
                }

                // Fill missing phones
                if (!hasPhone && contacts.phones.length > 0) {
                    job.phones = contacts.phones;
                    job.enriched_phones = true;
                }

                // If we found something, stop
                if (job.enriched_emails || job.enriched_phones) {
                    logger.debug(`Enriched: ${job.hospital_name}`, {
                        emails: job.emails?.length,
                        phones: job.phones?.length
                    });
                    return job;
                }
            }
        }
    }

    return job;
}

/**
 * Enrich multiple jobs in parallel
 * @param {Object[]} jobs - Array of job objects
 * @param {number} concurrency - Max concurrent enrichments
 * @returns {Promise<Object[]>} Enriched jobs
 */
async function enrichJobs(jobs, concurrency = 3) {
    // Only enrich jobs missing contacts
    const needsEnrichment = jobs.filter(j =>
        (!j.emails || j.emails.length === 0) ||
        (!j.phones || j.phones.length === 0)
    );

    if (needsEnrichment.length === 0) {
        logger.info('No jobs need enrichment');
        return jobs;
    }

    logger.info(`Enriching ${needsEnrichment.length} jobs with missing contacts`);

    let enrichedCount = 0;

    // Process in batches for concurrency
    for (let i = 0; i < needsEnrichment.length; i += concurrency) {
        const batch = needsEnrichment.slice(i, i + concurrency);
        await Promise.all(batch.map(async job => {
            const before = {
                emails: job.emails?.length || 0,
                phones: job.phones?.length || 0
            };

            await enrichJob(job);

            if (job.enriched_emails || job.enriched_phones) {
                enrichedCount++;
            }
        }));
    }

    logger.info(`Enrichment completed`, {
        attempted: needsEnrichment.length,
        enriched: enrichedCount,
        rate: `${Math.round((enrichedCount / needsEnrichment.length) * 100)}%`
    });

    return jobs;
}

module.exports = {
    enrichJobs,
    enrichJob,
    guessWebsiteFromName,
    extractContactsFromHtml
};
// module.exports = enrichJobs;