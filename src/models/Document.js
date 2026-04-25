const mongoose = require("mongoose");
const { Schema } = mongoose;

const documentSchema = new Schema(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

        userRole: {
            type: String,
            enum: ["staff", "hospital"],
            required: true
        },

        documents: [
            {
                _id: {
                    type: Schema.Types.ObjectId,
                    default: () => new mongoose.Types.ObjectId()
                },

                documentType: {
                    type: String,
                    required: true,
                    enum: [
                        "aadhaar-card",
                        "pan-card",
                        "degree-certificate",
                        "mcim-certificate",
                        "ncim-certificate",
                        "license-permit",
                        "resume-experience",
                        "recommendation-letter",
                        "cin-certificate",
                        "gst-certificate",
                        "nabh-certificate",
                        "rohini-certificate",
                        "cghs-certificate",
                        "live-picture",
                        "registration-certificate",
                        "Other"
                    ]
                },

                s3Key: {
                    type: String,
                    required: true
                },

                fileName: {
                    type: String
                },

                extractedText: {
                    type: String
                },

                // Structured data extracted from OCR text by document-specific parsers
                // Schema varies by documentType:
                // - aadhaar-card: { name, dob, gender, aadhaarNumber, address }
                // - pan-card: { name, dob, panNumber }
                // - mcim-certificate: { doctorName, registrationNumber }
                // - ncim-certificate: { doctorName, registrationNumber }
                // - license-permit: { licenseNumber, name, issueDate, expiryDate }
                // - cin-certificate: { businessName, cin, incorporationDate }
                // - gst-certificate: { legalName, tradeName, businessType, registrationNumber }
                // - nabh-certificate: { certificateNumber, hospitalName, validUpto }
                // - rohini-certificate: { certificateNumber, hospitalName, validUpto }
                // - cghs-certificate: { empanelmentNumber, hospitalName, validUpto }
                extractedData: {
                    type: Schema.Types.Mixed
                },

                isDeleted: {
                    type: Boolean,
                    default: false
                },

                uploadedAt: {
                    type: Date,
                    default: Date.now
                },

                updatedAt: {
                    type: Date,
                    default: Date.now
                },

                verificationStatus: {
                    type: String,
                    enum: [
                        "pending",
                        "verified",
                        "rejected",
                        "auto-verified",
                        "manual-pending-verification"
                    ],
                    default: "pending"
                },

                verifiedBy: {
                    type: Schema.Types.ObjectId,
                    ref: "User"
                },

                verifiedAt: Date,

                rejectionReason: String,

                verificationMeta: {
                    provider: String,
                    rawResponse: Schema.Types.Mixed,
                    requestId: String,
                    referenceId: String,
                    status: String,
                    verifiedAt: Date
                }
            }
        ]
    },
    { timestamps: true }
);

// Primary lookup - one doc record per user
documentSchema.index({ userId: 1 }, { unique: true });

// Fetch a specific document type for a user (most common query)
documentSchema.index({ userId: 1, "documents.documentType": 1 });

// Admin dashboard: filter by verification status (pending/rejected queue)
documentSchema.index({ "documents.verificationStatus": 1 });

// Admin dashboard: filter by role + status (e.g., all pending hospital docs)
documentSchema.index({ userRole: 1, "documents.verificationStatus": 1 });

// Audit trail: find all docs verified/rejected by a specific admin
documentSchema.index({ "documents.verifiedBy": 1 });

// Soft-delete aware queries: skip deleted docs efficiently
documentSchema.index({ userId: 1, "documents.isDeleted": 1 });

module.exports = mongoose.model("Document", documentSchema);