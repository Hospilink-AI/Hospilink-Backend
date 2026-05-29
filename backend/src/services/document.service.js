const Document = require("../models/Document");
const MedicalStaff = require("../models/MedicalStaff");
const Hospital = require("../models/Hospital");
const { uploadToS3, generatePreSignedURL, deleteFromS3 } = require("./s3.service");
const requiredDocsConfig = require("../config/requiredDocs");
const { extractTextFromBuffer } = require("./ocr.service");
const { paginateArray } = require("../utils/pagination");
const notificationEmitter = require('./notificationEmitter');
const idfyService = require("./idfy.service");
const { extractTextFromPDF } = require("./pdf.service");
const { isDocumentExpired } = require("../utils/documentExpiryValidator");
const logger = require('../utils/logger');

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

// Sync isDocumentsUploaded flag on MedicalStaff or Hospital after any doc change
const syncDocumentsUploadedFlag = async (userId, userRole) => {
    try {
        const config = requiredDocsConfig[userRole];
        if (!config) return;

        const mongoose = require('mongoose');
        const cacheService = require('./cache.service');

        const userObjectId = typeof userId === 'string'
            ? new mongoose.Types.ObjectId(userId)
            : userId;

        const docRecord = await Document.findOne({ userId: userObjectId }).select('documents').lean();
        const uploadedTypes = (docRecord?.documents || [])
            .filter(d => !d.isDeleted)
            .map(d => d.documentType);

        const allRequiredPresent = (config.required || [])
            .every(type => uploadedTypes.includes(type));

        const allConditionalPresent = (config.conditional || [])
            .every(group => group.some(type => uploadedTypes.includes(type)));

        const isDocumentsUploaded = allRequiredPresent && allConditionalPresent;

        if (userRole === 'staff') {
            await MedicalStaff.updateOne({ user: userObjectId }, { isDocumentsUploaded });
        } else if (userRole === 'hospital') {
            await Hospital.updateOne({ user: userObjectId }, { isDocumentsUploaded });
        }

        // Invalidate profile cache so next GET /profile/me returns fresh data
        await cacheService.invalidateProfile(userObjectId.toString(), userRole);

        console.log(`[syncDocumentsUploadedFlag] userId=${userId} role=${userRole} flag=${isDocumentsUploaded}`);
    } catch (err) {
        const logger = require('../utils/logger');
        logger.error(`syncDocumentsUploadedFlag failed userId=${userId} role=${userRole}: ${err.message}`);
    }
};

exports.uploadDocument = async (user, file, documentType, options = {}) => {

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
                // await deleteFromS3(existingDoc.s3Key || existingDoc.url);
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

    let verificationStatus = "pending";
    let verificationMeta = null;

    let extractedText = "";
    let extractedData = {};

    // Run OCR only for supported docs
    try {

        if (ocrSupportedDocs.includes(documentType)) {

            // OCR
            const isPDF = file.mimetype === "application/pdf";

            extractedText = isPDF ? await extractTextFromPDF(file.buffer)
                : await extractTextFromBuffer(file.buffer, file.mimetype, documentType);

            //Parse
            if (parserMap[documentType]) {
                extractedData = parserMap[documentType](extractedText);
            }
            // Note: extractedData intentionally not logged — contains PII (Aadhaar, PAN, DOB)
            // EXPIRY VALIDATION

            const expirySupportedDocs = [

                "mcim-certificate",
                "ncim-certificate",
                "license-permit",
                "rohini-certificate",
                "nabh-certificate",
                "cghs-certificate"

            ];

            if (
                expirySupportedDocs.includes(documentType) &&
                isDocumentExpired(extractedData)
            ) {

                verificationStatus = "rejected";

                verificationMeta = {
                    provider: "expiry-validator",
                    status: "expired",
                    verifiedAt: new Date()
                };

                logger.info(`Document rejected: expired type=${documentType}`);
            }

            // Hospital Certificate Verification
            if (
                verificationStatus !== "rejected" &&
                (
                    documentType === "rohini-certificate" ||
                    documentType === "cghs-certificate" ||
                    documentType === "nabh-certificate"
                )
            ) {
                try {
                    const hospitalVerificationService = require("./hospitalVerification.service");

                    const result = await hospitalVerificationService.verifyHospital({
                        certificateNumber: extractedData.rohiniId || extractedData.certificateNumber,
                        hospitalName: extractedData.hospitalName,
                        city: extractedData.location || extractedData.city
                    });

                    logger.info(`Hospital verification result: status=${result.status} source=${result.source} type=${documentType}`);

                    verificationStatus = result.status;

                    verificationMeta = {
                        provider: result.source,
                        status: result.status,
                        verifiedAt: new Date()
                    };

                } catch (err) {
                    console.error("Hospital verification error:", err);
                    verificationStatus = "manual-pending-verification";
                }
            }

            // IDFY
            if (
                documentType === "pan-card" ||
                documentType === "gst-certificate" ||
                documentType === "cin-certificate"
            ) {
                verificationStatus = "manual-pending-verification";

                try {
                    let idfyResponse = null;

                    const formatDOB = (dob) => {
                        if (!dob) return null;
                        const [day, month, year] = dob.split("/");
                        return `${year}-${month}-${day}`;
                    };

                    // PAN
                    if (
                        documentType === "pan-card" &&
                        extractedData.panNumber &&
                        extractedData.name &&
                        extractedData.dob
                    ) {
                        const cleanPAN = extractedData.panNumber.replace(/\s+/g, "").toUpperCase();
                        const formattedDOB = formatDOB(extractedData.dob);

                        idfyResponse = await idfyService.verifyPAN({
                            pan: cleanPAN,
                            name: extractedData.name,
                            dob: formattedDOB
                        });
                        // IDFY response not logged — may contain PII
                    }

                    // GST
                    if (
                        documentType === "gst-certificate" &&
                        extractedData.registrationNumber
                    ) {
                        idfyResponse = await idfyService.verifyGST(
                            extractedData.registrationNumber
                        );
                        // IDFY response not logged — may contain PII
                    }

                    // CIN
                    if (
                        documentType === "cin-certificate" &&
                        extractedData.cin
                    ) {
                        idfyResponse = await idfyService.verifyCIN(
                            extractedData.cin
                        );
                        // IDFY response not logged — may contain PII
                    }

                    if (idfyResponse && idfyResponse.request_id) {
                        logger.info(`IDFY task queued: type=${documentType} requestId=${idfyResponse.request_id}`);

                        verificationMeta = {
                            provider: "idfy",
                            requestId: idfyResponse.request_id,
                            status: "in_progress",
                            type: documentType,
                            createdAt: new Date()
                        };
                        processIdfyResultAsync(
                            userDocs._id,
                            idfyResponse.request_id,
                            documentType
                        );
                    } else {
                        logger.warn(`IDFY request_id missing for type=${documentType}`);
                    }

                } catch (err) {
                    console.error(" IDFY error:", err.message);
                    verificationStatus = "manual-pending-verification";
                }
            }
            // Aadhaar Digilocker Verification
            if (documentType === "aadhaar-card") {

                verificationStatus = "pending";

                try {
                    const referenceId = crypto.randomUUID();

                    const idfyResponse = await idfyService.verifyAadhaarDigilocker(referenceId);

                    if (idfyResponse && idfyResponse.request_id) {
                        logger.info(`Aadhaar Digilocker task queued: requestId=${idfyResponse.request_id}`);

                        // Check if redirect_url is directly in the initial response
                        let redirectUrl = idfyResponse.redirect_url || idfyResponse.redirect_uri || null;

                        if (!redirectUrl) {
                            // Poll up to 3 times with short delays — if IDFY fails fast, stop early
                            for (let attempt = 1; attempt <= 3; attempt++) {
                                await new Promise(res => setTimeout(res, 1500));
                                const taskResult = await idfyService.getTaskResult(idfyResponse.request_id);
                                const task = taskResult?.[0];

                                // If IDFY already failed, no point continuing
                                if (task?.status === "failed") {
                                    logger.warn(`Aadhaar Digilocker task failed: ${task.error} - ${task.message}`);
                                    break;
                                }

                                const sourceOutput = task?.result?.source_output;
                                redirectUrl =
                                    task?.result?.redirect_url ||
                                    task?.result?.redirect_uri ||
                                    sourceOutput?.redirect_url ||
                                    sourceOutput?.redirect_uri ||
                                    task?.redirect_url ||
                                    null;

                                if (redirectUrl) {
                                    logger.info(`Aadhaar redirect_url obtained on attempt ${attempt}`);
                                    break;
                                }
                            }
                        }

                        verificationMeta = {
                            provider: "idfy-digilocker",
                            requestId: idfyResponse.request_id,
                            referenceId: referenceId,
                            status: "initiated",
                            type: "aadhaar-card",
                            redirectUrl,
                            createdAt: new Date()
                        };

                    }

                } catch (err) {
                    logger.error(`Aadhaar verification error: ${err.message}`);
                }
            }

            const {
                extractQRFromBuffer,
                detectQRType,
                decodeBase64QR,
                fetchQRUrlData
            } = require("./qr.service");

            if (
                verificationStatus !== "rejected" &&
                (
                    documentType === "mcim-certificate" ||
                    documentType === "ncim-certificate" ||
                    documentType === "license-permit"
                )
            ) {
                const parseMCIMHtml = require("./parsers/mcimHtml.parser");
                const parseNCIMHtml = require("./parsers/ncimHtml.parser");
                const { compareCertificateData } = require("../utils/compare");

                let qrRaw = null;
                let qrType = null;
                let qrMatched = false;

                try {
                    qrRaw = await extractQRFromBuffer(file.buffer);
                    qrType = detectQRType(qrRaw);
                    // QR raw data not logged — may contain encoded PII

                    // URL QR
                    if (verificationStatus !== "auto-verified" && verificationStatus !== "rejected" && qrType === "url") {

                        const html = await fetchQRUrlData(qrRaw);

                        if (html) {
                            let qrData = {};

                            if (documentType === "mcim-certificate" || documentType === "license-permit") {
                                qrData = parseMCIMHtml(html);
                            }

                            if (documentType === "ncim-certificate") {
                                qrData = parseNCIMHtml(html);
                            }

                            const normalizedOCR = {
                                name: extractedData.doctorName || extractedData.name,
                                registrationNumber: extractedData.registrationNumber || extractedData.licenseNumber
                            };

                            const result = compareCertificateData(normalizedOCR, qrData);

                            if (result === "match" || result === "partial") {
                                verificationStatus = "auto-verified";
                                qrMatched = true;
                            } else {
                                verificationStatus = "manual-pending-verification";
                            }
                        } else {
                            verificationStatus = "manual-pending-verification";
                        }
                    }
                    // BASE64 QR
                    else if (verificationStatus !== "auto-verified" && verificationStatus !== "rejected" && qrType === "base64") {

                        const decoded = decodeBase64QR(qrRaw);
                        // Decoded QR not logged — contains registration numbers

                        let ocrReg = extractedData.registrationNumber;

                        // simple fallback
                        if (!ocrReg && decoded) {
                            ocrReg = decoded;
                        }

                        if (decoded && ocrReg) {
                            const ocrNumber = ocrReg.toString().replace(/\D/g, "");

                            if (ocrNumber.endsWith(decoded)) {
                                verificationStatus = "auto-verified";
                                qrMatched = true;
                            } else {
                                verificationStatus = "manual-pending-verification";
                            }
                            extractedData.registrationNumber = ocrNumber;
                        } else if (verificationStatus !== "auto-verified") {
                            verificationStatus = "manual-pending-verification";
                        }
                    }
                    // NO QR → DO NOT OVERRIDE IF ALREADY VERIFIED
                    else if (
                        verificationStatus !== "auto-verified" &&
                        documentType !== "aadhaar-card"
                    ) {
                        verificationStatus = "manual-pending-verification";
                    }
                } catch (err) {
                    console.error("QR verification error:", err);
                    verificationStatus = "manual-pending-verification";
                }
                if (!qrMatched) {
                    verificationStatus = "manual-pending-verification";
                }
            }

            // auto verification 
            if (
                documentType === "aadhaar-card" &&
                extractedData.aadhaarNumber &&
                !verificationMeta // only before Digilocker starts
            ) {
                verificationStatus = "pending";
            }

        }
    } catch (err) {
        console.error("OCR failed:", err);
        throw err;
    }

    userDocs.documents.push({
        documentType,
        s3Key: key,
        fileName: file.originalname,
        extractedText,
        extractedData,
        verificationStatus,
        verificationMeta
    });
    await userDocs.save();

    // Sync the isDocumentsUploaded flag — awaited so cache is invalidated
    // before the response is returned to the client
    await syncDocumentsUploadedFlag(user._id, user.role);

    let redirectUrl = null;

    if (documentType === "aadhaar-card") {
        // redirectUrl is stored in verificationMeta from the initial IDFY response.
        // No need for a separate getTaskResult call — the URL is available immediately.
        redirectUrl = verificationMeta?.redirectUrl || null;
    }

    return {
        documentType,
        verificationStatus,
        uploadedAt: new Date(),
        s3Key: key,
        redirectUrl
    };
};
const processIdfyResultAsync = async (userDocId, requestId, documentType) => {
    let attempts = 0;
    const maxAttempts = 30;

    const interval = setInterval(async () => {
        attempts++;

        try {
            const result = await idfyService.getTaskResult(requestId);
            const task = result?.[0];

            if (!task) return;

            if (task.status === "completed") {
                clearInterval(interval);

                const source = task?.result?.source_output;

                const userDoc = await Document.findById(userDocId);
                if (!userDoc) return;

                const doc = userDoc.documents.find(
                    d => d.verificationMeta?.requestId === requestId
                );

                if (!doc) return;

                let isVerified = false;

                if (documentType === "pan-card") {
                    isVerified = source?.status === "id_found";
                }

                if (documentType === "gst-certificate") {
                    isVerified = source?.gstin_status === "Active";
                }

                if (documentType === "cin-certificate") {
                    isVerified = source?.company_status === "Active";
                }

                doc.verificationStatus = isVerified
                    ? "auto-verified"
                    : "rejected";

                doc.verificationMeta.status = "completed";
                doc.verificationMeta.rawResponse = source;
                doc.verificationMeta.verifiedAt = new Date();

                await userDoc.save();

                // Invalidate profile cache so GET /profile reflects the new status
                try {
                    const cacheService = require('./cache.service');
                    await cacheService.invalidateProfile(userDoc.userId.toString(), userDoc.userRole);
                } catch (cacheErr) {
                    console.error('Failed to invalidate profile cache after IDFY result:', cacheErr.message);
                }

                logger.info(`IDFY verified (event-based): type=${documentType}`);
            }

            if (attempts >= maxAttempts) {
                clearInterval(interval);
                logger.warn(`IDFY max polling attempts reached for requestId=${requestId}`);
            }

        } catch (err) {
            console.error(" IDFY polling error:", err.message);
        }
    }, 10000); // every 10 sec
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


// Document verification
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

    // Invalidate profile cache so GET /profile reflects the verified status
    try {
        const cacheService = require('./cache.service');
        await cacheService.invalidateProfile(docRecord.userId._id.toString(), docRecord.userRole);
    } catch (cacheErr) {
        console.error('Failed to invalidate profile cache after document verification:', cacheErr.message);
    }

    const result = {
        documentId: document._id,
        documentType: document.documentType,
        verificationStatus: document.verificationStatus,
        verifiedBy: document.verifiedBy,
        verifiedAt: document.verifiedAt,
        userId: docRecord.userId._id,
        userName: docRecord.userId.name,
        userEmail: docRecord.userId.email
    };

    // Emit notification to user
    try {
        await notificationEmitter.emitDocumentVerified(result, docRecord.userRole);
    } catch (error) {
        console.error('Error emitting document verification notification:', error);
    }

    return result;
};



// Document rejection
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

    // Invalidate profile cache so GET /profile reflects the rejected status
    try {
        const cacheService = require('./cache.service');
        await cacheService.invalidateProfile(docRecord.userId._id.toString(), docRecord.userRole);
    } catch (cacheErr) {
        console.error('Failed to invalidate profile cache after document rejection:', cacheErr.message);
    }

    const result = {
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

    // Emit notification to user
    try {
        await notificationEmitter.emitDocumentRejected(result, docRecord.userRole);
    } catch (error) {
        console.error('Error emitting document rejection notification:', error);
    }

    return result;
};



// Get required documents status
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

    // Sync the isDocumentsUploaded flag — awaited so cache is invalidated
    // before the response is returned to the client
    await syncDocumentsUploadedFlag(user._id, user.role);

    return true;
};