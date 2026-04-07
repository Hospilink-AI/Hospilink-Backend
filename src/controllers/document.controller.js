const documentService = require("../services/document.service");
const { deleteFromS3 } = require("../services/s3.service");

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
        // console.log("USER:", req.user);

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
            }

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

        res.status(500).json({
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

        const result =
            await documentService.verifyDocument(documentId, adminId);

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

        const result =
            await documentService.rejectDocument(
                documentId,
                adminId,
                reason
            );

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

// const documentService = require("../services/document.service");

// exports.uploadDocument = async (req, res) => {

//     try {

//         const user = req.user;
//         const file = req.file;

//         if (!file) {
//             return res.status(400).json({
//                 success: false,
//                 message: "No file uploaded"
//             });
//         }

//         const documentType = req.body.documentType;

//         const result = await documentService.uploadDocument(user, file, documentType);

//         res.status(200).json({
//             success: true,
//             data: result
//         });

//     } catch (error) {

//         res.status(500).json({
//             success: false,
//             message: error.message
//         });

//     }
// };