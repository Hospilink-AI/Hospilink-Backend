const Document = require('../models/Document');
const idfyService = require('./idfy.service');
const cacheService = require('./cache.service');
const logger = require('../utils/logger');
const identityCheck = require('./identityCheck.service');

/**
 * Results of IDfy's PAN, GST and CIN checks.
 *
 * IDfy answers these checks later, so the result has to be fetched. A
 * timer inside the web server used to do that; a restart (every deploy)
 * lost it and the document stayed "in progress" for good, and with several
 * server tasks nothing else would pick it up. Now the document itself says
 * the check is in progress, a job every minute fetches the results (one
 * server at a time), and one early check runs shortly after the upload.
 */
const PROVIDER = 'idfy';
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_AFTER_MS = 15 * 1000;
const BATCH = 100;
// An admin's decision is never overwritten by a late result
const UNDECIDED = ['pending', 'manual-pending-verification'];

// Same rules as before: a clear "found / active" verifies, anything else
// in a completed answer rejects
function isVerified(documentType, source) {
    if (documentType === 'pan-card') return source?.status === 'id_found';
    if (documentType === 'gst-certificate') return source?.gstin_status === 'Active';
    if (documentType === 'cin-certificate') return source?.company_status === 'Active';
    return false;
}

// Update one document entry, only while it is still waiting and no admin
// has decided it, so two servers can't both apply a result
async function settle(recordId, entryId, set) {
    const fields = {};
    for (const [key, value] of Object.entries(set)) fields[`documents.$.${key}`] = value;
    fields['documents.$.updatedAt'] = new Date();
    const result = await Document.updateOne(
        {
            _id: recordId,
            documents: {
                $elemMatch: { _id: entryId, 'verificationMeta.status': 'in_progress', verificationStatus: { $in: UNDECIDED } }
            }
        },
        { $set: fields }
    );
    return result.modifiedCount > 0;
}

/**
 * Fetch and apply the result for one waiting entry.
 * @returns {Promise<string>} 'verified' | 'review' | 'rejected' | 'failed' | 'timed_out' | 'waiting'
 */
async function checkEntry(record, entry, now = Date.now()) {
    const requestId = entry.verificationMeta?.requestId;
    const result = requestId ? await idfyService.getTaskResult(requestId) : null;
    const task = Array.isArray(result) ? result[0] : null;
    let outcome = 'waiting';
    let changed = false;

    if (task?.status === 'completed') {
        const source = task.result?.source_output;
        const verified = isVerified(entry.documentType, source);
        // A real PAN must also be this person's: the name on the card has to
        // match the profile, or an admin checks it
        const decision = verified && entry.documentType === 'pan-card'
            ? await identityCheck.panDecision(record.userId, record.userRole, entry.extractedData?.name)
            : { autoVerify: true, reason: null };
        outcome = !verified ? 'rejected' : (decision.autoVerify ? 'verified' : 'review');
        changed = await settle(record._id, entry._id, {
            verificationStatus: !verified ? 'rejected' : (decision.autoVerify ? 'auto-verified' : 'manual-pending-verification'),
            'verificationMeta.status': decision.autoVerify ? 'completed' : decision.reason,
            'verificationMeta.rawResponse': source,
            'verificationMeta.verifiedAt': new Date()
        });
    } else if (task?.status === 'failed') {
        // IDfy couldn't check it: an admin reviews it
        outcome = 'failed';
        changed = await settle(record._id, entry._id, {
            verificationStatus: 'manual-pending-verification',
            'verificationMeta.status': 'failed'
        });
    } else if (now - new Date(entry.uploadedAt || 0).getTime() > GIVE_UP_AFTER_MS) {
        outcome = 'timed_out';
        changed = await settle(record._id, entry._id, {
            verificationStatus: 'manual-pending-verification',
            'verificationMeta.status': 'timed_out'
        });
    }

    if (changed) {
        await cacheService.invalidateProfile(record.userId.toString(), record.userRole).catch(() => {});
        identityCheck.checkSoon(record.userId);
        logger.info(`IDfy result applied: type=${entry.documentType} requestId=${requestId} outcome=${outcome}`);
    }
    return outcome;
}

const waitingEntries = (record) => (record.documents || []).filter(entry =>
    !entry.isDeleted &&
    UNDECIDED.includes(entry.verificationStatus) &&
    entry.verificationMeta?.provider === PROVIDER &&
    entry.verificationMeta?.status === 'in_progress'
);

/**
 * Every waiting check, oldest uploads first. Run from the cron job.
 * @returns {Promise<{checked: number, settled: number}>}
 */
async function checkPending({ limit = BATCH } = {}) {
    const records = await Document.find({
        'documents.verificationMeta.status': 'in_progress',
        documents: {
            $elemMatch: {
                'verificationMeta.provider': PROVIDER,
                'verificationMeta.status': 'in_progress',
                verificationStatus: { $in: UNDECIDED },
                isDeleted: { $ne: true }
            }
        }
    })
        .select('userId userRole documents._id documents.documentType documents.isDeleted documents.verificationStatus documents.uploadedAt documents.verificationMeta.provider documents.verificationMeta.status documents.verificationMeta.requestId documents.extractedData.name')
        .limit(limit)
        .lean();

    let checked = 0;
    let settled = 0;
    for (const record of records) {
        for (const entry of waitingEntries(record)) {
            checked++;
            try {
                const outcome = await checkEntry(record, entry);
                if (outcome !== 'waiting') settled++;
            } catch (err) {
                logger.warn(`IDfy result check failed for requestId=${entry.verificationMeta?.requestId}: ${err.message}`);
            }
        }
    }
    return { checked, settled };
}

/**
 * One early check shortly after an upload, so most results show within
 * seconds. Best effort: the cron job covers anything this misses.
 */
function checkSoon(userId, requestId, delayMs = FIRST_CHECK_AFTER_MS) {
    const timer = setTimeout(async () => {
        try {
            const record = await Document.findOne({ userId })
                .select('userId userRole documents._id documents.documentType documents.isDeleted documents.verificationStatus documents.uploadedAt documents.verificationMeta.provider documents.verificationMeta.status documents.verificationMeta.requestId documents.extractedData.name')
                .lean();
            const entry = record && waitingEntries(record).find(e => e.verificationMeta.requestId === requestId);
            if (entry) await checkEntry(record, entry);
        } catch (err) {
            logger.warn(`Early IDfy result check failed for requestId=${requestId}: ${err.message}`);
        }
    }, delayMs);
    if (timer.unref) timer.unref();
    return timer;
}

module.exports = {
    GIVE_UP_AFTER_MS,
    isVerified,
    checkEntry,
    checkPending,
    checkSoon
};
