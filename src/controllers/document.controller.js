const documentService = require("../services/document.service");
const Document = require("../models/Document");
const User = require("../models/User");
const rules = require("../config/requiredDocs");
const { deleteFromS3 } = require("../services/s3.service");
const activityLogEmitter = require('../services/activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');

exports.uploadDocument = async (req, res) => {
    try {

        const user = req.user;
        const files = req.files;
        const replace = req.query.replace === 'true'; // Get replace flag from query

        if (!files || files.length === 0) {
            return res.status(400).json({
                success: false,
                message: "No files uploaded"
            });
        }

        const uploadedKeys = []; // Track S3 keys for rollback
        const results = [];

        try {
            // Upload files sequentially to enable proper rollback
            for (const file of files) {
                const documentType = file.fieldname;
                const result = await documentService.uploadDocument(
                    user,
                    file,
                    documentType,
                    { replace }
                );

                // Track the S3 key for potential rollback
                uploadedKeys.push(result.s3Key);
                results.push(result);

                // Log each uploaded document
                activityLogEmitter.emitDocumentActivity(
                    replace ? ACTIVITY_ACTIONS.DOCUMENT_RESUBMITTED : ACTIVITY_ACTIONS.DOCUMENT_UPLOADED,
                    { documentType, fileName: file.originalname, verificationStatus: result.verificationStatus },
                    { userId: user._id || user.id, name: user.name, role: user.role, email: user.email },
                    {},
                    req
                ).catch(() => { });
            }
            const userDocs = await Document.findOne({ userId: user._id });

            let isComplete = false;

            if (userDocs) {
                const uploadedTypes = userDocs.documents
                    .filter(doc => !doc.isDeleted)
                    .map(doc => doc.documentType);

                const requiredDocs = rules[user.role]?.required || [];

                isComplete = requiredDocs.every(doc =>
                    uploadedTypes.includes(doc)
                );
            }

            // update user
            await User.findByIdAndUpdate(user._id, {
                isDocumentsUploaded: isComplete
            });

            res.status(200).json({
                success: true,
                count: results.length,
                data: results
            });

        } catch (uploadError) {
            // Rollback: delete all successfully uploaded files from S3
            if (uploadedKeys.length > 0) {
                await Promise.allSettled(
                    uploadedKeys.map(key => deleteFromS3(key))
                );
            }

            throw uploadError; // Re-throw to outer catch
        }

    } catch (error) {

        const statusCode =
            error.message.includes("does not match")
                ? 400
                : 500;

        res.status(statusCode).json({
            success: false,
            message: error.message
        });

    }
};


exports.getDocuments = async (req, res) => {

    try {

        const user = req.user;
        const { page, limit } = req.query;

        const result = await documentService.getUserDocuments(user, { page, limit });

        res.status(200).json({
            success: true,
            ...result
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }
};


exports.getDocumentById = async (req, res) => {

    try {

        const user = req.user;
        const { documentId } = req.params;

        const document = await documentService.getDocumentById(user, documentId);

        res.status(200).json({
            success: true,
            data: document
        });

    } catch (error) {

        res.status(404).json({
            success: false,
            message: error.message
        });

    }
};


exports.verifyDocument = async (req, res) => {

    try {

        const adminId = req.user._id;
        const { documentId } = req.params;

        const result = await documentService.verifyDocument(documentId, adminId);

        activityLogEmitter.emitDocumentActivity(
            ACTIVITY_ACTIONS.DOCUMENT_VERIFIED_BY_ADMIN,
            { _id: documentId, documentType: result.documentType, fileName: result.fileName, verificationStatus: 'verified' },
            { userId: req.user._id || req.user.id, name: req.user.name, role: 'admin', email: req.user.email },
            { targetUserId: result.userId, targetUserName: result.userName },
            req
        ).catch(() => { });

        res.json({
            success: true,
            message: "Document verified successfully",
            data: result
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }
};


exports.rejectDocument = async (req, res) => {

    try {

        const adminId = req.user._id;
        const { documentId } = req.params;
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({
                success: false,
                message: "Rejection reason is required"
            });
        }

        const result = await documentService.rejectDocument(documentId, adminId, reason);

        activityLogEmitter.emitDocumentActivity(
            ACTIVITY_ACTIONS.DOCUMENT_REJECTED_BY_ADMIN,
            { _id: documentId, documentType: result.documentType, fileName: result.fileName, verificationStatus: 'rejected' },
            { userId: req.user._id || req.user.id, name: req.user.name, role: 'admin', email: req.user.email },
            { targetUserId: result.userId, targetUserName: result.userName, reason },
            req
        ).catch(() => { });

        res.json({
            success: true,
            data: result
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }
};


exports.getRequiredDocuments = async (req, res) => {

    try {

        const status =
            await documentService.getRequiredDocumentsStatus(req.user);

        res.json({
            success: true,
            message: "Required documents status",
            data: status
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }
};


exports.deleteDocument = async (req, res) => {

    try {

        await documentService.deleteDocument(
            req.user,
            req.params.documentId
        );

        activityLogEmitter.emitDocumentActivity(
            ACTIVITY_ACTIONS.DOCUMENT_DELETED,
            { _id: req.params.documentId, documentType: 'document' },
            { userId: req.user._id || req.user.id, name: req.user.name, role: req.user.role, email: req.user.email },
            {},
            req
        ).catch(() => { });

        res.json({
            success: true,
            message: "Document deleted"
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }
};
