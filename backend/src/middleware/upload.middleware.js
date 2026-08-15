const multer = require("multer");
const { fromBuffer } = require("file-type");

const storage = multer.memoryStorage();


const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";


const ALLOWED_MIME_TYPES = new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "application/pdf",
    DOCX_MIME_TYPE
]);


const ALLOWED_DETECTED_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "application/pdf",
    DOCX_MIME_TYPE
]);

const fileFilter = (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        return cb(
            new Error("Only JPEG, PNG, PDF, or DOCX files are allowed"),
            false
        );
    }
    cb(null, true);
};

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    fileFilter
});



const validateMagicBytes = async (req, res, next) => {
    try {
        // Collect all uploaded files — multer puts them in req.files (array/object) or req.file
        const files = req.files
            ? Array.isArray(req.files)
                ? req.files
                : Object.values(req.files).flat()
            : req.file
                ? [req.file]
                : [];

        if (files.length === 0) return next();

        for (const file of files) {
            if (!file.buffer || file.buffer.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: `File "${file.originalname}" is empty`
                });
            }

            const detected = await fromBuffer(file.buffer);

            // fromBuffer returns null if it can't identify the format
            if (!detected) {
                return res.status(400).json({
                    success: false,
                    message: `File "${file.originalname}" has an unrecognised format. Only JPEG, PNG, and PDF are accepted.`
                });
            }

            if (!ALLOWED_DETECTED_TYPES.has(detected.mime)) {
                return res.status(400).json({
                    success: false,
                    message: `File "${file.originalname}" appears to be ${detected.mime} based on its content, which is not allowed. Only JPEG, PNG, and PDF are accepted.`
                });
            }

            // Extra check: claimed MIME must be consistent with detected MIME.
            // Prevents e.g. a PNG being uploaded with Content-Type: application/pdf.
            const claimedBase =
                file.mimetype === "image/jpg"
                    ? "image/jpeg"
                    : file.mimetype;

            const imageTypes = ["image/jpeg", "image/png"];

            const bothImages =
                imageTypes.includes(claimedBase) &&
                imageTypes.includes(detected.mime);

            if (!bothImages && claimedBase !== detected.mime) {
                return res.status(400).json({
                    success: false,
                    message: `File "${file.originalname}" content does not match its declared type (claimed: ${file.mimetype}, detected: ${detected.mime}).`
                });
            }
        }

        next();
    } catch (err) {
        next(err);
    }
};

module.exports = upload;
module.exports.validateMagicBytes = validateMagicBytes;
module.exports.DOCX_MIME_TYPE = DOCX_MIME_TYPE;
