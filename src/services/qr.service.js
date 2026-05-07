// const jsQR = require("jsqr");
// const sharp = require("sharp");
// const axios = require("axios");

// // exports.extractQRFromBuffer = async (buffer) => {
// //     try {
// //         const { data, info } = await sharp(buffer)
// //             .ensureAlpha()
// //             .raw()
// //             .toBuffer({ resolveWithObject: true });

// //         const code = jsQR(
// //             new Uint8ClampedArray(data),
// //             info.width,
// //             info.height
// //         );

// //         return code ? code.data : null;

// //     } catch (err) {
// //         console.error("QR extraction failed:", err);
// //         return null;
// //     }
// // };
// exports.extractQRFromBuffer = async (buffer) => {

//     try {

//         // ========= TRY FULL IMAGE =========

//         let processed = await sharp(buffer)
//             .resize({
//                 width: 2200,
//                 withoutEnlargement: false
//             })
//             .grayscale()
//             .normalise()
//             .sharpen()
//             .ensureAlpha()
//             .raw()
//             .toBuffer({ resolveWithObject: true });

//         let code = jsQR(
//             new Uint8ClampedArray(processed.data),
//             processed.info.width,
//             processed.info.height
//         );

//         if (code) {
//             return code.data;
//         }

//         // ========= TRY CROPPED LEFT QR AREA =========

//         const meta = await sharp(buffer).metadata();

//         const cropWidth = Math.floor(meta.width * 0.28);
//         const cropHeight = Math.floor(meta.height * 0.45);

//         processed = await sharp(buffer)
//             .extract({
//                 left: 0,
//                 top: Math.floor(meta.height * 0.15),
//                 width: cropWidth,
//                 height: cropHeight
//             })
//             .resize({
//                 width: 1800,
//                 withoutEnlargement: false
//             })
//             .grayscale()
//             .normalise()
//             .sharpen()
//             .ensureAlpha()
//             .raw()
//             .toBuffer({ resolveWithObject: true });

//         code = jsQR(
//             new Uint8ClampedArray(processed.data),
//             processed.info.width,
//             processed.info.height
//         );

//         return code ? code.data : null;

//     } catch (err) {

//         console.error("QR extraction failed:", err);

//         return null;
//     }
// };

// exports.detectQRType = (qrData) => {
//     if (!qrData) return "none";
//     if (qrData.startsWith("http")) return "url";
//     if (/^[A-Za-z0-9+/=]+$/.test(qrData)) return "base64";
//     return "unknown";
// };

// exports.decodeBase64QR = (qrData) => {
//     try {
//         const decoded = Buffer.from(qrData, "base64").toString("utf-8");
//         return decoded.replace(/\D/g, "");
//     } catch (err) {
//         return null;
//     }
// };

// exports.fetchQRUrlData = async (url) => {
//     try {
//         const res = await axios.get(url, {
//             headers: { "User-Agent": "Mozilla/5.0" }
//         });
//         return res.data;
//     } catch (err) {
//         console.error("Fetch error:", err.message);
//         return null;
//     }
// };
const jsQR = require("jsqr");
const sharp = require("sharp");
const axios = require("axios");

exports.extractQRFromBuffer = async (buffer) => {

    try {

        //FULL IMAGE

        let processed = await sharp(buffer)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        let code = jsQR(
            new Uint8ClampedArray(processed.data),
            processed.info.width,
            processed.info.height
        );

        if (code) {
            return code.data;
        }
        // TRY ENHANCED LARGE VERSION

        processed = await sharp(buffer)
            .resize({
                width: 2200,
                withoutEnlargement: false
            })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        code = jsQR(
            new Uint8ClampedArray(processed.data),
            processed.info.width,
            processed.info.height
        );

        if (code) {
            return code.data;
        }

        //CROPPED QR AREA

        const meta = await sharp(buffer).metadata();

        const cropWidth = Math.floor(meta.width * 0.28);
        const cropHeight = Math.floor(meta.height * 0.45);

        processed = await sharp(buffer)
            .extract({
                left: 0,
                top: Math.floor(meta.height * 0.12),
                width: cropWidth,
                height: cropHeight
            })
            .resize({
                width: 1800,
                withoutEnlargement: false
            })
            .ensureAlpha() 
            .raw()
            .toBuffer({ resolveWithObject: true });

        code = jsQR(
            new Uint8ClampedArray(processed.data),
            processed.info.width,
            processed.info.height
        );

        return code ? code.data : null;

    } catch (err) {

        console.error("QR extraction failed:", err);

        return null;
    }
};

exports.detectQRType = (qrData) => {

    if (!qrData) return "none";

    if (qrData.startsWith("http")) return "url";

    if (/^[A-Za-z0-9+/=]+$/.test(qrData)) {
        return "base64";
    }

    return "unknown";
};

exports.decodeBase64QR = (qrData) => {

    try {

        const decoded = Buffer
            .from(qrData, "base64")
            .toString("utf-8");

        return decoded.replace(/\D/g, "");

    } catch (err) {

        return null;
    }
};

exports.fetchQRUrlData = async (url) => {

    try {

        const res = await axios.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0"
            }
        });

        return res.data;

    } catch (err) {

        console.error("Fetch error:", err.message);

        return null;
    }
};