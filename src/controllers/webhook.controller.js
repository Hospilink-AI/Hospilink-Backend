const Document = require("../models/Document");

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

        console.log("AADHAAR VERIFIED SUCCESS");

        res.sendStatus(200);

    } catch (err) {
        console.error("Webhook Error:", err);
        res.sendStatus(500);
    }
};