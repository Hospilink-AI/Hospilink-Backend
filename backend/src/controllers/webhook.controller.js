const crypto = require("crypto");
const Document = require("../models/Document");
const cacheService = require('../services/cache.service');
const logger = require('../utils/logger');
const notificationEmitter = require('../services/notificationEmitter');
const identityCheck = require('../services/identityCheck.service');
const { maskAadhaarDeep } = require('../utils/aadhaarMask');
const activityLogEmitter = require('../services/activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');

// Only a clear success with the Aadhaar details auto-verifies. Any other
// status (failed, in progress, expired, missing or new) goes to manual review.
const IDFY_SUCCESS_STATUSES = ['completed', 'success', 'successful', 'verified'];

/**
 * Verify the webhook token embedded in the request URL query string.
 *
 * IDFY does not support HMAC webhook signing, so we use a secret token
 * embedded in the callback URL that we register with them via email:
 *   POST /api/webhook/idfy-aadhaar?wt=<IDFY_WEBHOOK_TOKEN>
 *
 * Uses timingSafeEqual to prevent timing-based enumeration of the token.
 */
function verifyWebhookToken(receivedToken) {
    const expected = process.env.IDFY_WEBHOOK_TOKEN;

    if (!expected) {
        logger.error('IDFY_WEBHOOK_TOKEN is not configured — rejecting all webhook requests');
        return false;
    }

    if (!receivedToken) return false;

    // Pad to equal length before comparing to satisfy timingSafeEqual requirement
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(receivedToken);

    if (expectedBuf.length !== receivedBuf.length) return false;

    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

exports.handleAadhaarWebhook = async (req, res) => {
    try {
        // ── 1. Token verification ─────────────────────────────────────────────
        const receivedToken = req.query.wt;

        if (!verifyWebhookToken(receivedToken)) {
            logger.warn('Webhook rejected: invalid or missing token', { ip: req.ip });
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        // ── 2. Validate payload ───────────────────────────────────────────────
        const data = req.body;

        const requestId = data.reference_id;
        if (!requestId) {
            logger.warn('Webhook rejected: missing reference_id in payload');
            return res.status(400).json({ success: false, message: 'Invalid payload: missing reference_id' });
        }

        // ── 3. Update document ────────────────────────────────────────────────
        // Anything short of a clear success goes to manual review instead of
        // being marked verified
        const reportedStatus = String(data.status || '').trim().toLowerCase();
        const hasDetails = data.parsed_details && typeof data.parsed_details === 'object'
            && Object.keys(data.parsed_details).length > 0;
        const owner = await Document.findOne({
            "documents.verificationMeta.referenceId": requestId
        }).select('userId userRole').lean();

        let checkFailed = !(IDFY_SUCCESS_STATUSES.includes(reportedStatus) && hasDetails);
        let reviewReason = reportedStatus || 'unknown';
        if (checkFailed) {
            logger.warn(`Aadhaar webhook sent to manual review: referenceId=${requestId}, status=${reportedStatus || 'none'}, details=${hasDetails}`);
        } else if (owner) {
            // DigiLocker says the Aadhaar is real; it must also be this
            // person's: the name has to match the profile, and the date of
            // birth must not differ from their other documents
            const decision = await identityCheck.aadhaarDecision(owner.userId, owner.userRole, data.parsed_details);
            if (!decision.autoVerify) {
                checkFailed = true;
                reviewReason = decision.reason;
                logger.warn(`Aadhaar webhook sent to manual review: referenceId=${requestId}, reason=${decision.reason}`);
            }
        }

        // Stored with every Aadhaar number masked to its last 4 digits
        const storedResponse = maskAadhaarDeep(data);
        const storedDetails = storedResponse.parsed_details;

        const result = await Document.updateOne(
            {
                "documents.verificationMeta.referenceId": requestId,
                "documents.documentType": "aadhaar-card"
            },
            {
                $set: checkFailed
                    ? {
                        "documents.$.verificationStatus": "manual-pending-verification",
                        "documents.$.verificationMeta.status": reviewReason,
                        "documents.$.verificationMeta.rawResponse": storedResponse,
                        // DigiLocker's details, for the admin who reviews it
                        ...(hasDetails ? { "documents.$.extractedData": storedDetails } : {})
                    }
                    : {
                        "documents.$.verificationStatus": "auto-verified",
                        "documents.$.verificationMeta.status": "completed",
                        "documents.$.verificationMeta.rawResponse": storedResponse,
                        "documents.$.verificationMeta.verifiedAt": new Date(),
                        "documents.$.extractedData": storedDetails
                    }
            }
        );

        // ── 4. Invalidate profile cache ───────────────────────────────────────
        if (result.modifiedCount > 0) {
            try {
                const docRecord = owner;

                if (docRecord) {
                    identityCheck.checkSoon(docRecord.userId);
                    await cacheService.invalidateProfile(docRecord.userId.toString(), docRecord.userRole);
                    if (!checkFailed) {
                        await notificationEmitter.emitDocumentAutoVerified(docRecord.userId.toString(), 'aadhaar-card');
                    }
                    activityLogEmitter.emitDocumentActivity(
                        checkFailed ? ACTIVITY_ACTIONS.DOCUMENT_UPLOADED : ACTIVITY_ACTIONS.DOCUMENT_VERIFIED,
                        { documentId: requestId, documentType: 'aadhaar-card', verificationStatus: checkFailed ? 'manual-pending-verification' : 'auto-verified' },
                        { userId: null, name: 'IDfy', role: 'system' },
                        { provider: 'idfy', reportedStatus: reportedStatus || null, userId: docRecord.userId.toString() }
                    ).catch(() => {});
                }
            } catch (cacheErr) {
                logger.error(`Failed to invalidate profile cache after Aadhaar webhook: ${cacheErr.message}`);
            }
        }

        logger.info(`Aadhaar webhook processed: referenceId=${requestId}, modified=${result.modifiedCount}`);
        res.status(200).json({ success: true, message: 'Webhook processed successfully' });

    } catch (err) {
        logger.error(`Webhook error: ${err.message}`);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};
