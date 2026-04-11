const Document = require("../models/Document");
const { uploadToS3, generatePreSignedURL, deleteFromS3 } = require("./s3.service");
const requiredDocsConfig = require("../config/requiredDocs");
const { extractTextFromBuffer } = require("./ocr.service");
const { paginateArray } = require("../utils/pagination");
//const { verifyAadhaar, checkDocumentFraud } = require("./hyperverge.service");
const notificationEmitter = require('./notificationEmitter');

const getAllowedDocs = (role) => {
    const config = requiredDocsConfig[role];

    if (!config) {
        throw new Error("Invalid role");
    }

    return [
        ...(config.required || []),
        ...(config.optional || []),
        ...(config.conditional || []).flat()
    ];
};

const validateDocumentType = (role, documentType) => {
    const allowedDocs = getAllowedDocs(role);

    if (!allowedDocs.includes(documentType)) {
        throw new Error(
            `Invalid documentType "${documentType}" for role "${role}". Allowed types: ${allowedDocs.join(", ")}`
        );
    }
};

// Role → folder mapping
const getFolderByRole = (role) => {

    if (role === "hospital") return "hospital";

    if (role === "staff")
        return "medical-staff";

    throw new Error("Invalid user role");

};

// Parser Map 
const parserMap = {
    "aadhaar-card": require("./parsers/aadhaar.parser"),
    "pan-card": require("./parsers/pan.parser"),

    "mcim-certificate": require("./parsers/mcim.parser"),
    "ncim-certificate": require("./parsers/ncim.parser"),
    "license-permit": require("./parsers/license.parser"),

    "cin-certificate": require("./parsers/cin.parser"),
    "gst-certificate": require("./parsers/gst.parser"),

    "nabh-certificate": require("./parsers/nabh.parser"),
    "rohini-certificate": require("./parsers/rohini.parser"),
    "cghs-certificate": require("./parsers/cghs.parser")
};
//OCR supported document types
const ocrSupportedDocs = [
    "aadhaar-card",
    "pan-card",
    "mcim-certificate",
    "ncim-certificate",
    "license-permit",
    "cin-certificate",
    "gst-certificate",
    "nabh-certificate",
    "rohini-certificate",
    "cghs-certificate"
];

// Allowed document types
// const allowedDocumentTypes = [
//     "aadhaar-card",
//     "pan-card",
//     "degree-certificate",
//     "mcim-certificate",
//     "ncim-certificate",
//     "license-permit",
//     "resume-experience",
//     "recommendation-letter",
//     "cin-certificate",
//     "gst-certificate",
//     "nabh-certificate",
//     "rohini-certificate",
//     "cghs-certificate",
//     "live-picture",
//     "registration-certificate",
//     "Other"
// ];

exports.uploadDocument = async (user, file, documentType, options = {}) => {

    // if (!allowedDocumentTypes.includes(documentType)) {
    //     throw new Error("Invalid document type");
    // }

    validateDocumentType(user.role, documentType);

    let userDocs = await Document.findOne({ userId: user._id });
    //create document if not exists
    if (!userDocs) {
        userDocs = new Document({
            userId: user._id,
            userRole: user.role,
            documents: []
        });
    }
    // Check for existing document
    const existingDoc = userDocs?.documents.find(
        d => d.documentType === documentType && !d.isDeleted
    );

    if (existingDoc) {
        // If replace flag is true, soft-delete old doc and delete from S3
        if (options.replace) {
            try {
                await deleteFromS3(existingDoc.s3Key);
                existingDoc.isDeleted = true;
            } catch (error) {
                console.error("Failed to delete old document from S3:", error);
                // Continue with upload even if S3 delete fails
            }
        } else {
            throw new Error(`${documentType} already uploaded. Use replace=true to update.`);
        }
    }

    const folder = getFolderByRole(user.role);

    const timestamp = Date.now();

    // sanitize filename (remove spaces)
    const sanitizedFileName = file.originalname.replace(/\s+/g, "-");

    const key =
        `documents/${folder}/${user._id}/${documentType}/${timestamp}-${sanitizedFileName}`;

    await uploadToS3(file.buffer, key, file.mimetype);

    // let verificationStatus = "pending";
    // let hypervergeData = null;

    // try {

    //     if (documentType === "aadhaar-card") {

    //         const hvResponse = await verifyAadhaar(file.buffer);

    //         const verified = hvResponse?.status?.toLowerCase() === "success";

    //         verificationStatus = verified ? "auto-verified" : "rejected";

    //         hypervergeData = {
    //             confidenceScore: hvResponse?.result?.confidence || 0,
    //             extractedAadhaarNumber: hvResponse?.result?.aadhaar_number,
    //             verificationTimestamp: new Date(),
    //             rawResponse: hvResponse
    //         };

    //     }

    //     else {

    //         const hvResponse = await checkDocumentFraud(file.buffer);

    //         const fraudDetected =
    //             hvResponse?.result?.fraudDetected === true ||
    //             hvResponse?.result?.fraud === true;

    //         verificationStatus = fraudDetected ? "rejected" : "pending";

    //         hypervergeData = {
    //             confidenceScore: hvResponse?.result?.confidence || 0,
    //             verificationTimestamp: new Date(),
    //             rawResponse: hvResponse
    //         };

    //     }

    // } catch (error) {

    //     console.error("HyperVerge verification failed:", error);
    //     verificationStatus = "pending";

    // }

    // HyperVerge verification disabled temporarily
    // let verificationStatus = "pending";
    // let hypervergeData = null;

    // userDocs.documents.push({
    //     documentType,
    //     url: key,
    //     verificationStatus,
    //     hypervergeData
    // });

    let verificationStatus = "pending";
    let hypervergeData = null;

    let extractedText = "";
    let extractedData = {};

    // Run OCR only for supported docs
    try {

        if (ocrSupportedDocs.includes(documentType)) {

            // OCR
            extractedText = await extractTextFromBuffer(file.buffer, file.mimetype);

            //Parse
            if (parserMap[documentType]) {
                extractedData = parserMap[documentType](extractedText);
            }

            const {
                extractQRFromBuffer,
                detectQRType,
                decodeBase64QR,
                fetchQRUrlData
            } = require("./qr.service");

            const parseMCIMHtml = require("./parsers/mcimHtml.parser");
            const { compareCertificateData } = require("../utils/compare");

            let qrRaw = null;
            let qrType = null;

            try {
                qrRaw = await extractQRFromBuffer(file.buffer);
                qrType = detectQRType(qrRaw);

                console.log("QR RAW:", qrRaw);
                console.log("QR TYPE:", qrType);

                // URL QR
                if (qrType === "url") {

                    const html = await fetchQRUrlData(qrRaw);

                    if (html) {
                        const qrData = parseMCIMHtml(html);

                        const normalizedOCR = {
                            name: extractedData.doctorName,
                            registrationNumber: extractedData.registrationNumber
                        };

                        const result = compareCertificateData(normalizedOCR, qrData);

                        if (result === "match" || result === "partial") {
                            verificationStatus = "auto-verified";
                        } else {
                            verificationStatus = "manual-pending-verification";
                        }
                    } else {
                        verificationStatus = "manual-pending-verification";
                    }
                }
                // BASE64 QR
                else if (qrType === "base64") {

                    const decoded = decodeBase64QR(qrRaw);
                    console.log("DECODED QR:", decoded);

                    let ocrReg = extractedData.registrationNumber;

                    // simple fallback
                    if (!ocrReg && decoded) {
                        ocrReg = decoded;
                    }

                    if (decoded && ocrReg) {
                        const ocrNumber = ocrReg.toString().replace(/\D/g, "");

                        if (ocrNumber.endsWith(decoded)) {
                            verificationStatus = "auto-verified";
                        } else {
                            verificationStatus = "manual-pending-verification";
                        }
                        extractedData.registrationNumber = ocrNumber;
                    } else {
                        verificationStatus = "manual-pending-verification";
                    }
                }
                // NO QR
                else {
                    verificationStatus = "manual-pending-verification";
                }

            } catch (err) {
                console.error("QR verification error:", err);
                verificationStatus = "manual-pending-verification";
            }

            // auto verification 
            if (documentType === "aadhaar-card" && extractedData.aadhaarNumber) {
                verificationStatus = "pending";
            }

        }
    } catch (err) {
        console.error("OCR failed:", err);
    }

    userDocs.documents.push({
        documentType,
        s3Key: key,
        fileName: file.originalname,
        extractedText,
        extractedData,
        verificationStatus,
        hypervergeData
    });
    await userDocs.save();

    return {
        documentType,
        verificationStatus,
        uploadedAt: new Date(),
        s3Key: key  // Return S3 key for rollback tracking
    };
};

exports.getUserDocuments = async (user, options = {}) => {

    const userDocs = await Document.findOne({ userId: user._id });

    if (!userDocs) {
        return {
            documents: [],
            pagination: {
                totalItems: 0,
                totalPages: 0,
                currentPage: parseInt(options.page) || 1,
                itemsPerPage: parseInt(options.limit) || 10,
                hasNextPage: false,
                hasPrevPage: false,
                nextPage: null,
                prevPage: null
            }
        };
    }

    // Filter non-deleted documents
    const activeDocuments = userDocs.documents.filter(doc => !doc.isDeleted);

    // Use pagination utility
    const { data: paginatedDocs, pagination } = paginateArray(
        activeDocuments,
        options.page,
        options.limit
    );

    const documentsWithUrls = await Promise.all(
        paginatedDocs.map(async (doc) => {

            const signedUrl = await generatePreSignedURL(doc.s3Key);

            return {
                documentId: doc._id,
                documentType: doc.documentType,
                verificationStatus: doc.verificationStatus,
                uploadedAt: doc.uploadedAt,
                updatedAt: doc.updatedAt,
                url: signedUrl,
                extractedData: doc.extractedData,
                fileName: doc.fileName
            };
        })
    );

    return {
        documents: documentsWithUrls,
        pagination
    };
};

exports.getDocumentById = async (user, documentId) => {

    const docRecord = await Document.findOne({
        userId: user._id,
        "documents._id": documentId
    });

    if (!docRecord) {
        throw new Error("Document not found");
    }

    const doc = docRecord.documents.id(documentId);

    if (!doc || doc.isDeleted) {
        throw new Error("Document not found");
    }

    const signedUrl = await generatePreSignedURL(doc.s3Key);

    return {
        documentId: doc._id,
        documentType: doc.documentType,
        verificationStatus: doc.verificationStatus,
        uploadedAt: doc.uploadedAt,
        updatedAt: doc.updatedAt,
        url: signedUrl,
        extractedData: doc.extractedData,
        fileName: doc.fileName
    };
};

exports.verifyDocument = async (documentId, adminId) => {

    const docRecord = await Document.findOne({
        "documents._id": documentId
    }).populate('userId', 'name email');

    if (!docRecord) {
        throw new Error("Document not found");
    }

    const document = docRecord.documents.id(documentId);

    if (!document) {
        throw new Error("Document not found");
    }

    if (document.isDeleted) {
        throw new Error("Document is deleted");
    }

    if (document.verificationStatus === "verified") {
        throw new Error("Document already verified");
    }

    document.verificationStatus = "verified";
    document.verifiedBy = adminId;
    document.verifiedAt = new Date();
    document.updatedAt = new Date();

    await docRecord.save();

    return {
        documentId: document._id,
        documentType: document.documentType,
        verificationStatus: document.verificationStatus,
        verifiedBy: document.verifiedBy,
        verifiedAt: document.verifiedAt,
        userId: docRecord.userId._id,
        userName: docRecord.userId.name,
        userEmail: docRecord.userId.email
    };
};

exports.rejectDocument = async (documentId, adminId, reason) => {

    const docRecord = await Document.findOne({
        "documents._id": documentId
    }).populate('userId', 'name email');

    if (!docRecord) {
        throw new Error("Document not found");
    }

    const document = docRecord.documents.id(documentId);

    if (!document) {
        throw new Error("Document not found");
    }

    if (document.isDeleted) {
        throw new Error("Document is deleted");
    }

    // Prevent rejecting already verified documents
    if (document.verificationStatus === "verified") {
        throw new Error("Verified document cannot be rejected");
    }

    document.verificationStatus = "rejected";
    document.verifiedBy = adminId;
    document.verifiedAt = new Date();
    document.rejectionReason = reason;
    document.updatedAt = new Date();

    await docRecord.save();

    return {
        documentId: document._id,
        documentType: document.documentType,
        verificationStatus: document.verificationStatus,
        rejectionReason: document.rejectionReason,
        verifiedBy: document.verifiedBy,
        verifiedAt: document.verifiedAt,
        userId: docRecord.userId._id,
        userName: docRecord.userId.name,
        userEmail: docRecord.userId.email
    };
};

exports.getRequiredDocumentsStatus = async (user) => {
    if (!requiredDocsConfig[user.role]) {
        throw new Error("Invalid role for document requirements");
    }
    const config = requiredDocsConfig[user.role];
    const userDocs = await Document.findOne({ userId: user._id });

    // Build uploaded documents list with full status
    const uploadedDocuments = userDocs
        ? userDocs.documents
            .filter(d => !d.isDeleted)
            .map(d => ({
                documentType: d.documentType,
                verificationStatus: d.verificationStatus,
                uploadedAt: d.uploadedAt,
                updatedAt: d.updatedAt,
                verifiedAt: d.verifiedAt,
                rejectionReason: d.rejectionReason,
                fileName: d.fileName
            }))
        : [];

    const uploadedDocTypes = uploadedDocuments.map(d => d.documentType);

    //Required docs
    const missingRequired = config.required.filter(
        doc => !uploadedDocTypes.includes(doc)
    );
    //Conditional docs 
    const missingConditional = [];
    config.conditional.forEach(group => {
        const hasOne = group.some(doc => uploadedDocTypes.includes(doc));
        if (!hasOne) {
            missingConditional.push(group);
        }
    });
    const isProfileComplete =
        missingRequired.length === 0 &&
        missingConditional.length === 0;
    return {
        requiredDocuments: config.required,
        conditionalGroups: config.conditional,
        optionalDocuments: config.optional,
        uploadedDocuments,
        missingRequired,
        missingConditional,
        isProfileComplete
    };
};

exports.deleteDocument = async (user, documentId) => {

    const docRecord = await Document.findOne({
        userId: user._id,
        "documents._id": documentId
    });

    if (!docRecord) {
        throw new Error("Document not found");
    }

    const document = docRecord.documents.id(documentId);

    if (!document) {
        throw new Error("Document not found");
    }

    if (document.isDeleted) {
        throw new Error("Document already deleted");
    }

    await deleteFromS3(document.s3Key);
    // Soft delete
    document.isDeleted = true;
    document.updatedAt = new Date();

    await docRecord.save();

    return true;
};