// const axios = require("axios");
// const FormData = require("form-data");

// const MDVS_BASE_URL = process.env.MDVS_BASE_URL;
// const MDVS_API_KEY = process.env.MDVS_API_KEY;

// console.log("[MDVS] BASE_URL loaded as:", MDVS_BASE_URL);

// // Map Hospilink types to MDVS types based on qualification
// const determineMdvsDocType = (hospilinkDocType, extractedData) => {
//     const q = (extractedData?.qualification || "").toUpperCase();
//     const r = (extractedData?.registrationNumber || "").toUpperCase();

//     if (hospilinkDocType === "ncim-certificate") {
//         if (q.includes("GNM") || q.includes("ANM") || q.includes("NURSING")) return "nurse-certificate";
//         return "nurse-certificate"; // Default fallback for NCIM
//     }

//     if (hospilinkDocType === "mcim-certificate" || hospilinkDocType === "license-permit") {
//         if (q.includes("BDS") || q.includes("MDS")) return "dentist-certificate";
//         if (q.includes("D.PHARM") || q.includes("B.PHARM")) return "pharmacist-certificate";
//         if (q.includes("BAMS") || r.includes("/AY/")) return "ayurved-certificate";
//         if (q.includes("BHMS") || r.includes("/HO/")) return "homeopathy-certificate";
//         if (q.includes("BUMS") || r.includes("/UN/")) return "unani-certificate";

//         // Default for MCIM is usually MBBS
//         return "mbbs-certificate";
//     }

//     // Pass hospital docs straight through
//     if (["rohini-certificate", "cghs-certificate", "nabh-certificate"].includes(hospilinkDocType)) {
//         return hospilinkDocType;
//     }

//     return null;
// };

// exports.verifyMedicalDocument = async (fileBuffer, originalName, hospilinkDocType, extractedData, userRole) => {
//     try {
//         const mdvsDocType = determineMdvsDocType(hospilinkDocType, extractedData);

//         if (!mdvsDocType) {
//             console.log("No MDVS mapping found for:", hospilinkDocType);
//             return null;
//         }

//         const formData = new FormData();
//         // Append buffer with explicit filename + MIME type
//         const guessedMime = originalName?.toLowerCase().endsWith(".pdf")
//             ? "application/pdf"
//             : originalName?.toLowerCase().endsWith(".png")
//                 ? "image/png"
//                 : "image/jpeg";

//         formData.append("file", fileBuffer, {
//             filename: originalName,
//             contentType: guessedMime
//         });

//         const endpoint = userRole === "hospital"
//             ? `${MDVS_BASE_URL}/hospital/${mdvsDocType}`
//             : `${MDVS_BASE_URL}/staff/${mdvsDocType}`;

//         const response = await axios.post(endpoint, formData, {
//             headers: {
//                 ...formData.getHeaders(),
//                 "x-api-key": MDVS_API_KEY
//             },
//             maxContentLength: Infinity,
//             maxBodyLength: Infinity,
//             timeout: 60000
//         });

//         return response.data; // Returns the Orchestrator result from MDVS
//     } catch (error) {
//         console.error("MDVS API Error:", error.response?.data || error.message);
//         return null;
//     }
// };
const axios = require("axios");
const FormData = require("form-data");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { createCanvas } = require("canvas");

const MDVS_BASE_URL = process.env.MDVS_BASE_URL;
const MDVS_API_KEY = process.env.MDVS_API_KEY;

console.log("[MDVS] BASE_URL loaded as:", MDVS_BASE_URL);

// Map Hospilink types to MDVS types based on qualification
const determineMdvsDocType = (hospilinkDocType, extractedData) => {
    const q = (extractedData?.qualification || "").toUpperCase();
    const r = (extractedData?.registrationNumber || "").toUpperCase();

    if (hospilinkDocType === "ncim-certificate") {
        if (q.includes("GNM") || q.includes("ANM") || q.includes("NURSING")) return "nurse-certificate";
        return "nurse-certificate";
    }

    if (hospilinkDocType === "mcim-certificate" || hospilinkDocType === "license-permit") {
        if (q.includes("BDS") || q.includes("MDS")) return "dentist-certificate";
        if (q.includes("D.PHARM") || q.includes("B.PHARM")) return "pharmacist-certificate";
        if (q.includes("BAMS") || r.includes("/AY/")) return "ayurved-certificate";
        if (q.includes("BHMS") || r.includes("/HO/")) return "homeopathy-certificate";
        if (q.includes("BUMS") || r.includes("/UN/")) return "unani-certificate";
        return "mbbs-certificate";
    }

    if (["rohini-certificate", "cghs-certificate", "nabh-certificate"].includes(hospilinkDocType)) {
        return hospilinkDocType;
    }

    return null;
};

// Convert first page of a PDF to a PNG buffer at high resolution.
// MDVS's image pipeline handles small QRs reliably; its PDF pipeline does not.
const convertPdfToPng = async (pdfBuffer) => {
    const uint8Array = new Uint8Array(pdfBuffer);
    const pdf = await pdfjsLib.getDocument({ data: uint8Array }).promise;
    const page = await pdf.getPage(1);

    // Scale 4 → high enough for small QRs to survive rasterization
    const viewport = page.getViewport({ scale: 4 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext("2d");

    await page.render({ canvasContext: ctx, viewport }).promise;

    return canvas.toBuffer("image/png");
};

exports.verifyMedicalDocument = async (fileBuffer, originalName, hospilinkDocType, extractedData, userRole) => {
    try {
        const mdvsDocType = determineMdvsDocType(hospilinkDocType, extractedData);

        if (!mdvsDocType) {
            console.log("No MDVS mapping found for:", hospilinkDocType);
            return null;
        }

        // Detect PDF by magic bytes (%PDF)
        const isPdf =
            fileBuffer[0] === 0x25 &&
            fileBuffer[1] === 0x50 &&
            fileBuffer[2] === 0x44 &&
            fileBuffer[3] === 0x46;

        let uploadBuffer = fileBuffer;
        let uploadName = originalName;
        let uploadMime = "image/jpeg";

        if (isPdf) {
            console.log("[MDVS] Converting PDF to PNG before forwarding…");
            try {
                uploadBuffer = await convertPdfToPng(fileBuffer);
                uploadName = originalName.replace(/\.pdf$/i, ".png");
                uploadMime = "image/png";
                console.log("[MDVS] PDF→PNG done. PNG size:", uploadBuffer.length, "bytes");
            } catch (err) {
                console.error("[MDVS] PDF→PNG conversion failed, sending original PDF:", err.message);
                uploadMime = "application/pdf";
            }
        } else {
            // For images, guess MIME from filename
            const lower = (originalName || "").toLowerCase();
            if (lower.endsWith(".png")) uploadMime = "image/png";
            else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) uploadMime = "image/jpeg";
        }

        const formData = new FormData();
        formData.append("file", uploadBuffer, {
            filename: uploadName,
            contentType: uploadMime
        });

        const endpoint = userRole === "hospital"
            ? `${MDVS_BASE_URL}/hospital/${mdvsDocType}`
            : `${MDVS_BASE_URL}/staff/${mdvsDocType}`;

        const response = await axios.post(endpoint, formData, {
            headers: {
                ...formData.getHeaders(),
                "x-api-key": MDVS_API_KEY
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 60000
        });

        return response.data;
    } catch (error) {
        console.error("MDVS API Error:", error.response?.data || error.message);
        return null;
    }
};