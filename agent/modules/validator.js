/**
 * CONVERTED TO COMMONJS for backend compatibility
 */
/**
 * Validator Module - Validates extracted job data
 */
const config = require('../utils/config');
const logger = require('../utils/logger');

// Email validation regex
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Indian phone number regex (10 digits, optional +91 prefix)
const PHONE_REGEX = /^(\+91[-\s]?)?[6-9]\d{9}$/;

/**
 * Normalize phone number to +91 format
 * @param {string} phone - Raw phone number
 * @returns {string|null} Normalized phone or null
 */
function normalizePhone(phone) {
    if (!phone) return null;

    // Remove all non-digit characters except +
    let cleaned = phone.replace(/[^\d+]/g, '');

    // Extract last 10 digits
    const digits = cleaned.replace(/\D/g, '');
    const last10 = digits.slice(-10);

    // Check if valid Indian mobile number (starts with 6-9)
    if (last10.length === 10 && /^[6-9]/.test(last10)) {
        // Format as +91-XXX-XXXXXXX
        return `+91-${last10.slice(0, 3)}-${last10.slice(3)}`;
    }

    return null;
}

/**
 * Check if email is a generic/non-useful email
 * @param {string} email - Email to check
 * @returns {boolean} True if generic
 */
function isGenericEmail(email) {
    if (!email) return true;

    const lowerEmail = email.toLowerCase();
    return config.genericEmails.some(prefix => lowerEmail.startsWith(prefix));
}

/**
 * Check if role matches the search query
 * @param {string} extractedRole - Role from extraction
 * @param {string} searchRole - User's search role
 * @returns {boolean}
 */
// Common job abbreviations
const ABBREVIATIONS = {
    'rmo': ['resident medical officer', 'medical officer', 'mbbs', 'doctor', 'physician'],
    'sr': ['senior'],
    'jr': ['junior'],
    'hr': ['human resources', 'human resource', 'recruiter', 'talent acquisition']
};

function roleMatches(extractedRole, searchRole) {
    if (!extractedRole || !searchRole) return false;

    const normalizedExtracted = extractedRole.toLowerCase();
    const normalizedSearch = searchRole.toLowerCase();

    // 0. Exact substring match (User usually knows what they want)
    if (normalizedExtracted.includes(normalizedSearch)) return true;

    // 1. Check Abbreviations
    // If search term is a known abbreviation, allow its expansions
    if (ABBREVIATIONS[normalizedSearch]) {
        const expansions = ABBREVIATIONS[normalizedSearch];
        if (expansions.some(exp => normalizedExtracted.includes(exp))) {
            return true;
        }
    }

    // Split search role into keywords
    const keywords = normalizedSearch.split(/\s+/).filter(k => k.length > 2);

    // If search was just an abbreviation (length <=3) and not in our list, 
    // we might want to be strict or lenient. 
    // If we have keywords, use the overlap logic.
    if (keywords.length === 0) {
        // Search "RMO" -> keywords empty (length<=2). 
        // Fallback: If short search term is keyword-like (3 chars), check existence
        if (normalizedSearch.length >= 2) {
            return normalizedExtracted.includes(normalizedSearch);
        }
        return false;
    }

    // Check if at least half of keywords match
    const matchCount = keywords.filter(kw => normalizedExtracted.includes(kw)).length;
    return matchCount >= Math.ceil(keywords.length / 2);
}

/**
 * Check if location matches the search query
 * @param {string} extractedLocation - Location from extraction
 * @param {string} searchLocation - User's search location
 * @returns {boolean}
 */
function locationMatches(extractedLocation, searchLocation) {
    if (!extractedLocation || !searchLocation) return false;

    const normalizedExtracted = extractedLocation.toLowerCase();
    const normalizedSearch = searchLocation.toLowerCase();

    // 1. Direct match
    if (normalizedExtracted.includes(normalizedSearch)) return true;
    if (normalizedSearch.includes(normalizedExtracted)) return true;

    // 2. Token overlap (Looser: Match ANY significant token)
    // "Hingewadi Pune" vs "Pune" -> Match (Pune exists)
    const searchTokens = normalizedSearch.split(/[\s,]+/).filter(t => t.length > 3); // Increased length to 3 to avoid 'in', 'at'

    // If search has no significant tokens (e.g. "pune"), fall back to direct match (already done)
    if (searchTokens.length === 0) return true;

    // Check if ANY significant search token exists in extracted location
    const anyTokenMatch = searchTokens.some(st => normalizedExtracted.includes(st));

    if (anyTokenMatch) return true;

    // Check for city aliases (e.g., "Mumbai" and "Bombay")
    const cityAliases = {
        'mumbai': ['bombay'],
        'chennai': ['madras'],
        'kolkata': ['calcutta'],
        'bengaluru': ['bangalore'],
        'pune': ['poona'],
        'gurugram': ['gurgaon']
    };

    for (const [city, aliases] of Object.entries(cityAliases)) {
        if (normalizedSearch.includes(city)) {
            if (aliases.some(alias => normalizedExtracted.includes(alias))) {
                return true;
            }
        }
        if (aliases.some(alias => normalizedSearch.includes(alias))) {
            if (normalizedExtracted.includes(city)) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Validate a single job entry
 * @param {Object} job - Job data to validate
 * @param {string} searchRole - User's search role
 * @param {string} searchLocation - User's search location
 * @returns {Object} { valid: boolean, reason: string|null, job: Object }
 */
function validateJob(job, searchRole, searchLocation) {
    const reasons = [];

    // Must have hospital name
    if (!job.hospital_name || job.hospital_name.trim() === '') {
        reasons.push('Missing hospital name');
    }

    // Handle both old (email/phone) and new (emails[]/phones[]) formats
    const emails = job.emails || (job.email ? [job.email] : []);
    const phones = job.phones || (job.phone ? [job.phone] : []);

    // Validate and normalize emails
    const validEmails = emails.filter(email => EMAIL_REGEX.test(email));

    // Validate and normalize phones
    const validPhones = phones.map(normalizePhone).filter(Boolean);

    // Check for WhatsApp
    const whatsapp = job.whatsapp ? normalizePhone(job.whatsapp) : null;

    // Set outreach_status based on contact availability (don't reject jobs without contact)
    if (validEmails.length === 0 && validPhones.length === 0 && !whatsapp) {
        // No contact info - mark for no direct outreach, but still keep the job
        job.outreach_status = 'no_direct_outreach';
        job.confidence_score = job.confidence_score || 0;
    } else {
        // Has some contact info
        if (!job.outreach_status) {
            job.outreach_status = (validEmails.length > 0 || validPhones.length > 0) ? 'ready' : 'partial';
        }
    }

    // Check for generic emails (warn but don't discard)
    const hasGenericEmail = validEmails.some(isGenericEmail);
    if (hasGenericEmail) {
        job._hasGenericEmail = true;
    }

    // Role should match (if extracted)
    if (job.role && !roleMatches(job.role, searchRole)) {
        reasons.push(`Role "${job.role}" doesn't match search "${searchRole}"`);
    }

    // Location should match (if extracted)
    if (job.location && !locationMatches(job.location, searchLocation)) {
        reasons.push(`Location "${job.location}" doesn't match search "${searchLocation}"`);
    }

    // Update job with validated/normalized contact info
    job.emails = validEmails;
    job.phones = validPhones;
    job.whatsapp = whatsapp;

    const isValid = reasons.length === 0;

    if (!isValid) {
        logger.info('Job validation failed', {
            hospital: job.hospital_name,
            reasons
        });
    }

    return {
        valid: isValid,
        reason: reasons.join('; ') || null,
        job
    };
}

/**
 * Validate multiple job entries
 * @param {Object[]} jobs - Array of job data
 * @param {string} searchRole - User's search role
 * @param {string} searchLocation - User's search location
 * @returns {Object} { valid: Object[], invalid: Object[], stats: Object }
 */
function validateJobs(jobs, searchRole, searchLocation) {
    logger.info(`Validating ${jobs.length} job entries`);

    const valid = [];
    const invalid = [];

    for (const job of jobs) {
        const result = validateJob(job, searchRole, searchLocation);
        if (result.valid) {
            result.job.validated = true;
            valid.push(result.job);
        } else {
            invalid.push({
                job: result.job,
                reason: result.reason
            });
        }
    }

    const stats = {
        total: jobs.length,
        valid: valid.length,
        invalid: invalid.length,
        validationRate: ((valid.length / jobs.length) * 100).toFixed(1) + '%'
    };

    logger.info('Validation completed', stats);

    return { valid, invalid, stats };
}

module.exports = { validateJob, validateJobs, normalizePhone, isGenericEmail, roleMatches, locationMatches };
// module.exports = validateJobs;