const express = require("express");
const router = express.Router();

const upload = require("../middleware/upload.middleware");
const controller = require("../controllers/document.controller");
const { protect } = require("../middleware/auth.middleware");
const { validateDocumentUpload } = require("../middleware/validation.middleware");

router.post(
    "/upload",
    protect,
    upload.any(),
    validateDocumentUpload,
    controller.uploadDocument
);

router.get("/", protect, controller.getDocuments);

// must be before /:documentId — otherwise Express treats "required-status" as a param value
router.get("/required-status", protect, controller.getRequiredDocuments);

router.get("/:documentId", protect, controller.getDocumentById);
// Admin routes
router.put(
    "/verify/:documentId",
    protect,
    controller.verifyDocument
);

router.put(
    "/reject/:documentId",
    protect,
    controller.rejectDocument
);

router.delete("/:documentId", protect, controller.deleteDocument);

module.exports = router;
