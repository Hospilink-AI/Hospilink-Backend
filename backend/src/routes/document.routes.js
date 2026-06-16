const express = require("express");
const router = express.Router();

const upload = require("../middleware/upload.middleware");
const { validateMagicBytes } = require("../middleware/upload.middleware");
const controller = require("../controllers/document.controller");
const { protect, checkSuspension } = require("../middleware/auth.middleware");
const {
    validateDocumentUpload,
    validateDocumentQuery,
    validateRequiredStatusQuery,
    validateDocumentIdParam
} = require("../middleware/validation.middleware");

router.use(protect);
router.use(checkSuspension);

router.post(
    "/upload",
    upload.any(),           // 1. multer: size limit + MIME type header check
    validateMagicBytes,     // 2. magic bytes: verify actual file content matches claimed type
    validateDocumentUpload, // 3. business rules: allowed document types per role
    controller.uploadDocument
);

router.get("/", validateDocumentQuery, controller.getDocuments);

// must be before /:documentId — otherwise Express treats "required-status" as a param value
router.get("/required-status", validateRequiredStatusQuery, controller.getRequiredDocuments);

router.get("/:documentId", validateDocumentIdParam, controller.getDocumentById);

router.delete("/:documentId", validateDocumentIdParam, controller.deleteDocument);

module.exports = router;