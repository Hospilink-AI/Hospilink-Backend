/**
 * CONVERTED TO COMMONJS for backend compatibility
 */
/**
 * Deduplicator Module - Removes duplicate job entries with contact-based merging
 * 
 * UPDATED: Enhanced merge logic based on email/phone/employer matching
 */
const logger = require('../utils/logger');

/**
 * Calculate similarity between two strings (Jaccard similarity)
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Similarity score 0-1
 */
function calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;

    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();

    if (s1 === s2) return 1;

    // Tokenize into words
    const tokens1 = new Set(s1.split(/\s+/).filter(t => t.length > 1));
    const tokens2 = new Set(s2.split(/\s+/).filter(t => t.length > 1));

    if (tokens1.size === 0 || tokens2.size === 0) return 0;

    // Calculate Jaccard similarity
    const intersection = new Set([...tokens1].filter(t => tokens2.has(t)));
    const union = new Set([...tokens1, ...tokens2]);

    return intersection.size / union.size;
}

/**
 * Normalize phone number to strict E.164 format (+91XXXXXXXXXX)
 * @param {string} phone 
 * @returns {string|null}
 */
function normalizePhone(phone) {
    if (!phone) return null;
    let digits = phone.replace(/\D/g, '');

    // Handle India defaults
    if (digits.length === 10) {
        digits = '91' + digits;
    } else if (digits.length === 12 && digits.startsWith('91')) {
        // already good
    } else {
        return null; // Invalid length
    }

    return `+${digits}`;
}

/**
 * Normalize email (lowercase + trim)
 */
function normalizeEmail(email) {
    if (!email) return null;
    return email.toLowerCase().trim();
}

/**
 * Normalize employer name for comparison
 * @param {string} name - Company/hospital name
 * @returns {string} Normalized name
 */
function normalizeEmployerName(name) {
    if (!name) return '';
    return name
        .toLowerCase()
        .replace(/\s*(pvt\.?|ltd\.?|private|limited|inc\.?|llc|hospital|clinic|healthcare|medical|centre|center)\s*/gi, '')
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Calculate completeness/signal score for a job entry
 * WhatsApp = highest close rate signal, then phone, then email
 * @param {Object} job - Job data
 * @returns {number} Completeness score
 */
function calculateCompleteness(job) {
    let score = 0;

    // Contact fields - WhatsApp is highest priority (best close rate)
    if (job.whatsapp) score += 15;  // WhatsApp = highest value
    if (job.phones && job.phones.length > 0) score += 10;  // Phone = high value
    if (job.emails && job.emails.length > 0) score += 6;   // Email = good value
    if (job.hr_contact) score += 4;

    // Essential fields
    if (job.hospital_name) score += 3;
    if (job.role) score += 2;
    if (job.location) score += 2;

    // Nice-to-have fields
    if (job.salary) score += 1;
    if (job.job_description) score += 1;
    if (job.apply_link) score += 1;
    if (job.posted_date) score += 1;

    // Confidence score bonus
    if (job.confidence_score) score += Math.floor(job.confidence_score / 20);

    return score;
}

/**
 * Check if two jobs have matching contact info
 * @param {Object} job1 - First job
 * @param {Object} job2 - Second job
 * @returns {boolean}
 */
function hasMatchingContact(job1, job2) {
    // Email match
    const emails1 = job1.emails || [];
    const emails2 = job2.emails || [];
    for (const e1 of emails1) {
        if (emails2.includes(e1)) return true;
    }

    // Phone match (normalize for comparison)
    const phones1 = (job1.phones || []).map(p => p.replace(/\D/g, ''));
    const phones2 = (job2.phones || []).map(p => p.replace(/\D/g, ''));
    for (const p1 of phones1) {
        for (const p2 of phones2) {
            if (p1 === p2 || p1.endsWith(p2) || p2.endsWith(p1)) return true;
        }
    }

    // WhatsApp match
    if (job1.whatsapp && job2.whatsapp) {
        const w1 = job1.whatsapp.replace(/\D/g, '');
        const w2 = job2.whatsapp.replace(/\D/g, '');
        if (w1 === w2) return true;
    }

    return false;
}

/**
 * Prioritize field values based on source reliability
 * @param {any} val1 
 * @param {any} val2 
 * @param {number} priority1 
 * @param {number} priority2 
 * @returns {any} Best value
 */
function pickBestField(val1, val2, priority1, priority2) {
    if (val1 && !val2) return val1;
    if (!val1 && val2) return val2;
    if (!val1 && !val2) return null;

    // Both exist - pick by priority
    return priority1 >= priority2 ? val1 : val2;
}

/**
 * Check if two jobs are duplicates
 * @param {Object} job1 - First job
 * @param {Object} job2 - Second job
 * @param {number} threshold - Similarity threshold (default 0.8)
 * @returns {boolean}
 */
function areDuplicates(job1, job2, threshold = 0.8) {
    // 1. Exact URL match
    if (job1.source_url && job2.source_url && job1.source_url === job2.source_url) {
        return true;
    }

    // 2. Contact info match (strong signal)
    if (hasMatchingContact(job1, job2)) {
        // Same contact = same job/employer
        return true;
    }

    // 3. Normalized employer name match + location
    const norm1 = normalizeEmployerName(job1.hospital_name);
    const norm2 = normalizeEmployerName(job2.hospital_name);
    if (norm1 && norm2 && norm1 === norm2) {
        // Same employer - check role similarity
        const roleSim = calculateSimilarity(job1.role, job2.role);
        if (roleSim >= 0.7) return true;
    }

    // 4. High similarity across all fields
    const hospitalSim = calculateSimilarity(job1.hospital_name, job2.hospital_name);
    const roleSim = calculateSimilarity(job1.role, job2.role);
    const locationSim = calculateSimilarity(job1.location, job2.location);

    if (hospitalSim >= threshold && roleSim >= threshold && locationSim >= 0.7) {
        return true;
    }

    return false;
}

/**
 * Merge two job entries, keeping the best fields from each
 * @param {Object} job1 - First job (higher priority)
 * @param {Object} job2 - Second job
 * @returns {Object} Merged job
 */
function mergeJobs(job1, job2) {
    const merged = { ...job1 };

    // 1. Merge & Normalize Contact Arrays
    const emails1 = (job1.emails || []).map(normalizeEmail).filter(Boolean);
    const emails2 = (job2.emails || []).map(normalizeEmail).filter(Boolean);
    merged.emails = [...new Set([...emails1, ...emails2])];

    const phones1 = (job1.phones || []).map(normalizePhone).filter(Boolean);
    const phones2 = (job2.phones || []).map(normalizePhone).filter(Boolean);
    merged.phones = [...new Set([...phones1, ...phones2])];

    // Determine signal strength for priority picking
    const score1 = calculateCompleteness(job1);
    const score2 = calculateCompleteness(job2);

    // 2. Pick best scalar fields
    const fields = ['whatsapp', 'hr_contact', 'salary', 'job_description', 'apply_link', 'posted_date'];

    for (const field of fields) {
        merged[field] = pickBestField(job1[field], job2[field], score1, score2);
    }

    // 3. Maximize confidence
    merged.confidence_score = Math.max(job1.confidence_score || 0, job2.confidence_score || 0);

    // 4. Track lineage
    merged.merged_from = [
        ...(job1.merged_from || [job1.source_url]),
        ...(job2.merged_from || [job2.source_url])
    ].filter(Boolean);

    // Ensure we keep the most recent update time
    merged.updated_at = new Date();

    return merged;
}

/**
 * Deduplicate job entries with merging
 * @param {Object[]} jobs - Array of job data
 * @param {boolean} enableMerge - Whether to merge duplicate entries (default: true)
 * @returns {Object} { unique: Object[], duplicates: number }
 */
function deduplicate(jobs, enableMerge = true) {
    logger.info(`Deduplicating ${jobs.length} job entries`);

    if (jobs.length === 0) {
        return { unique: [], duplicates: 0 };
    }

    // Sort by completeness (most complete first)
    const sortedJobs = [...jobs].sort((a, b) =>
        calculateCompleteness(b) - calculateCompleteness(a)
    );

    const unique = [];
    let duplicateCount = 0;

    for (const job of sortedJobs) {
        // Find any duplicate in unique list
        const duplicateIndex = unique.findIndex(existingJob =>
            areDuplicates(job, existingJob)
        );

        if (duplicateIndex === -1) {
            // No duplicate - add to unique
            unique.push(job);
        } else if (enableMerge) {
            // Merge with existing duplicate
            unique[duplicateIndex] = mergeJobs(unique[duplicateIndex], job);
            duplicateCount++;
            logger.debug('Merged duplicate', {
                hospital: job.hospital_name,
                mergedEmails: unique[duplicateIndex].emails.length
            });
        } else {
            // Skip duplicate
            duplicateCount++;
            logger.debug('Duplicate found', {
                hospital: job.hospital_name,
                url: job.source_url
            });
        }
    }

    logger.info('Deduplication completed', {
        input: jobs.length,
        unique: unique.length,
        duplicates: duplicateCount
    });

    return {
        unique,
        duplicates: duplicateCount
    };
}

module.exports = {
    deduplicate,
    areDuplicates,
    mergeJobs,
    hasMatchingContact,
    normalizeEmployerName,
    calculateSimilarity,
    calculateCompleteness
};
// module.exports = deduplicate;