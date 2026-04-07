/**
 * Filter Module - Evaluates SERP results for job signals
 * Filters out pages with no detectable job signal to reduce downstream LLM processing cost.
 * 
 * CONVERTED TO COMMONJS for backend compatibility
 */
const { logger } = require('../utils/logger');

// Job signal terms to look for in snippets, titles, and URLs
const JOB_SIGNAL_TERMS = [
    // Hiring signals
    'hiring', 'vacancy', 'vacancies', 'walk-in', 'walk in', 'urgent', 'recruitment',
    'opening', 'openings', 'position', 'positions', 'requirement', 'requirements',

    // Action signals
    'apply', 'resume', 'cv', 'interview', 'join', 'wanted', 'looking for',

    // Contact signals (high value)
    'phone', 'mobile', 'call', 'whatsapp', 'email', 'mail', 'contact',

    // HR signals
    'hr', 'human resource', 'careers', 'career', 'jobs', 'job',

    // Salary signals
    'salary', 'ctc', 'package', 'stipend', 'per month', 'p.m.', 'lpa',

    // Experience signals
    'fresher', 'experienced', 'years experience', 'yrs exp'
];

// High-value contact patterns (regex)
const CONTACT_PATTERNS = {
    email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
    phone: /(?:\+91[-\s]?)?[6-9]\d{9}|\d{2,4}[-\s]?\d{6,8}/g,
    whatsapp: /(?:wa\.me\/|whatsapp[:\s]+)[\d\s+-]+/gi
};

/**
 * Calculate job signal score for a SERP result
 * @param {Object} result - SERP result with title, snippet, url
 * @returns {number} Signal score (0-100)
 */
function calculateSignalScore(result) {
    const text = `${result.title || ''} ${result.snippet || ''} ${result.url || ''}`.toLowerCase();
    let score = 0;

    // Check for job signal terms
    for (const term of JOB_SIGNAL_TERMS) {
        if (text.includes(term.toLowerCase())) {
            score += 5;
        }
    }

    // Bonus for contact info in snippet (high value - means direct contact available)
    const snippet = result.snippet || '';
    if (CONTACT_PATTERNS.email.test(snippet)) {
        score += 25;
        result.hasEmailInSnippet = true;
    }
    if (CONTACT_PATTERNS.phone.test(snippet)) {
        score += 25;
        result.hasPhoneInSnippet = true;
    }
    if (CONTACT_PATTERNS.whatsapp.test(snippet)) {
        score += 20;
        result.hasWhatsappInSnippet = true;
    }

    // Extract contacts from snippet for later use
    result.snippetContacts = extractContactsFromText(snippet);

    // Cap at 100
    return Math.min(score, 100);
}

/**
 * Extract contact information from text
 * @param {string} text - Text to extract from
 * @returns {Object} { emails: [], phones: [], whatsapp: null }
 */
function extractContactsFromText(text) {
    if (!text) return { emails: [], phones: [], whatsapp: null };

    const emailMatches = text.match(CONTACT_PATTERNS.email) || [];
    const phoneMatches = text.match(CONTACT_PATTERNS.phone) || [];
    const whatsappMatch = text.match(CONTACT_PATTERNS.whatsapp);

    // Normalize phone numbers
    const phones = [...new Set(phoneMatches)]
        .map(p => {
            const digits = p.replace(/\D/g, '').slice(-10);
            if (digits.length === 10 && /^[6-9]/.test(digits)) {
                return `+91-${digits.slice(0, 3)}-${digits.slice(3)}`;
            }
            return null;
        })
        .filter(Boolean);

    // Extract emails (filter out example domains)
    const emails = [...new Set(emailMatches)]
        .filter(e => !e.includes('example.com') && !e.includes('domain.com'));

    // Extract WhatsApp number
    let whatsapp = null;
    if (whatsappMatch && whatsappMatch[0]) {
        const digits = whatsappMatch[0].replace(/\D/g, '').slice(-10);
        if (digits.length === 10) {
            whatsapp = `+91-${digits.slice(0, 3)}-${digits.slice(3)}`;
        }
    }

    return { emails, phones, whatsapp };
}

/**
 * Filter SERP results by job signal
 * @param {Object[]} serpResults - Array of { url, title, snippet, metadata }
 * @param {number} minScore - Minimum signal score (default: 10)
 * @returns {Object} { filtered: [], skipped: [], stats: {} }
 */
function filterByJobSignal(serpResults, minScore = 10) {
    logger.info(`Filtering ${serpResults.length} SERP results for job signals`);

    const filtered = [];
    const skipped = [];

    // List of file extensions to ignore
    const IGNORED_EXTENSIONS = [
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.zip', '.rar', '.7z', '.tar', '.gz',
        '.jpg', '.jpeg', '.png', '.gif', '.bmp',
        '.mp3', '.mp4', '.avi', '.mov'
    ];

    for (const result of serpResults) {
        // Skip binary files based on extension
        let urlLower = (result.url || '').toLowerCase();
        try {
            urlLower = decodeURIComponent(urlLower);
        } catch (e) { /* ignore encoding errors */ }

        if (IGNORED_EXTENSIONS.some(ext => urlLower.endsWith(ext) || urlLower.includes(ext + '?'))) {
            skipped.push({
                url: result.url,
                score: 0,
                reason: 'Ignored file type'
            });
            continue;
        }

        const score = calculateSignalScore(result);
        result.signalScore = score;

        if (score >= minScore) {
            filtered.push(result);
        } else {
            skipped.push({
                url: result.url,
                score,
                reason: 'No job signal detected'
            });
        }
    }

    // Sort by signal score (highest first)
    filtered.sort((a, b) => b.signalScore - a.signalScore);

    // Separate high-signal results (can extract from snippet alone)
    const highSignal = filtered.filter(r =>
        r.hasEmailInSnippet || r.hasPhoneInSnippet || r.hasWhatsappInSnippet
    );
    const needsFetch = filtered.filter(r =>
        !r.hasEmailInSnippet && !r.hasPhoneInSnippet && !r.hasWhatsappInSnippet
    );

    const stats = {
        total: serpResults.length,
        filtered: filtered.length,
        skipped: skipped.length,
        highSignal: highSignal.length,
        needsFetch: needsFetch.length
    };

    logger.info('Filter completed', stats);

    return {
        filtered,
        highSignal,
        needsFetch,
        skipped,
        stats
    };
}

/**
 * Check if a result has enough snippet contact info to skip fetching
 * @param {Object} result - SERP result with snippetContacts
 * @returns {boolean}
 */
function canExtractFromSnippet(result) {
    const contacts = result.snippetContacts || {};
    return (
        (contacts.emails && contacts.emails.length > 0) ||
        (contacts.phones && contacts.phones.length > 0) ||
        contacts.whatsapp
    );
}

module.exports = {
    filterByJobSignal,
    calculateSignalScore,
    extractContactsFromText,
    canExtractFromSnippet,
    JOB_SIGNAL_TERMS,
    CONTACT_PATTERNS
};