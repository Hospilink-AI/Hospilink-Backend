const express = require("express");
const router = express.Router();

const upload = require("../middleware/upload.middleware");
const controller = require("../controllers/document.controller");
const { protect } = require("../middleware/auth.middleware");
const { 
    validateDocumentUpload, 
    validateDocumentQuery,
    validateRequiredStatusQuery,
    validateDocumentIdParam
} = require("../middleware/validation.middleware");

router.post(
    "/upload",
    protect,
    upload.any(),
    validateDocumentUpload,
    controller.uploadDocument
);

router.get("/", protect, validateDocumentQuery, controller.getDocuments);

// must be before /:documentId — otherwise Express treats "required-status" as a param value
router.get("/required-status", protect, validateRequiredStatusQuery, controller.getRequiredDocuments);

router.get("/:documentId", protect, validateDocumentIdParam, controller.getDocumentById);

router.delete("/:documentId", protect, validateDocumentIdParam, controller.deleteDocument);

module.exports = router;