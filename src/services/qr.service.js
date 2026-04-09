const jsQR = require("jsqr");
const sharp = require("sharp");
const axios = require("axios");

exports.extractQRFromBuffer = async (buffer) => {
    try {
        const { data, info } = await sharp(buffer)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const code = jsQR(
            new Uint8ClampedArray(data),
            info.width,
            info.height
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
    if (/^[A-Za-z0-9+/=]+$/.test(qrData)) return "base64";
    return "unknown";
};

exports.decodeBase64QR = (qrData) => {
    try {
        const decoded = Buffer.from(qrData, "base64").toString("utf-8");
        return decoded.replace(/\D/g, "");
    } catch (err) {
        return null;
    }
};

exports.fetchQRUrlData = async (url) => {
    try {
        const res = await axios.get(url, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        return res.data;
    } catch (err) {
        console.error("Fetch error:", err.message);
        return null;
    }
};