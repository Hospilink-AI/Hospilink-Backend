const vision = require("@google-cloud/vision");

// Initialize Google Vision client
const client = new vision.ImageAnnotatorClient({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY,
    },
});

// Language hints based on document type
const getLanguageHints = (docType) => {
    if (docType === "aadhaar-card") {
        return ["en", "hi"]; // English and Hindi
    }
    return ["en"];
};

/**
 * Extract text from image buffer using Google Vision API
 * @param {Buffer} buffer - Image file buffer
 * @param {string} mimetype - File MIME type (must be image/*)
 * @param {string} docType - Document type for language optimization
 * @returns {Promise<string>} - Extracted text
 */
exports.extractTextFromBuffer = async (buffer, mimetype, docType = "") => {
    try {
        // Validate that it's an image
        if (!mimetype.startsWith("image/")) {
            throw new Error("Only image files are supported. Please upload JPEG, PNG, or WebP images.");
        }

        const languageHints = getLanguageHints(docType);

        // Process image with Google Vision API
        const request = {
            image: { content: buffer },
            imageContext: {
                languageHints: languageHints,
            },
        };

        const [result] = await client.textDetection(request);
        const detections = result.textAnnotations;

        if (!detections || detections.length === 0) {
            console.warn("[OCR] No text found in image");
            return "";
        }

        // First annotation contains the full text
        return detections[0].description || "";

    } catch (err) {
        logger.error(`Google Vision API Error: ${err.message}`);

        return "";
    }
};
