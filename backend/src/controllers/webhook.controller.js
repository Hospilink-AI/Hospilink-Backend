const Document = require("../models/Document");
const cacheService = require('../services/cache.service');

exports.handleAadhaarWebhook = async (req, res) => {
    try {
        const data = req.body;

        console.log("WEBHOOK RECEIVED:", JSON.stringify(data, null, 2));

        const requestId = data.reference_id;
        console.log("Updating requestId:", requestId);

        const result = await Document.updateOne(
            {
                "documents.verificationMeta.referenceId": requestId,
                "documents.documentType": "aadhaar-card"
            },
            {
                $set: {
                    "documents.$.verificationStatus": "auto-verified",
                    "documents.$.verificationMeta.status": "completed",
                    "documents.$.verificationMeta.rawResponse": data,
                    "documents.$.verificationMeta.verifiedAt": new Date(),
                    "documents.$.extractedData": data.parsed_details
                }
            }
        );

        console.log("UPDATE RESULT:", result);

        // Invalidate profile cache so GET /profile reflects the verified status
        if (result.modifiedCount > 0) {
            try {
                const docRecord = await Document.findOne({
                    "documents.verificationMeta.referenceId": requestId
                }).select('userId userRole').lean();

                if (docRecord) {
                    await cacheService.invalidateProfile(docRecord.userId.toString(), docRecord.userRole);
                }
            } catch (cacheErr) {
                console.error('Failed to invalidate profile cache after Aadhaar webhook:', cacheErr.message);
            }
        }

        console.log("AADHAAR VERIFIED SUCCESS");

        res.sendStatus(200);

    } catch (err) {
        console.error("Webhook Error:", err);
        res.sendStatus(500);
    }
};