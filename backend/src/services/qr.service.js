const jsQR = require("jsqr");
const sharp = require("sharp");
const axios = require("axios");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { getDocument } = pdfjsLib;
const { createCanvas } = require("canvas");

exports.extractQRFromBuffer = async (buffer) => {
    // PDF DETECTION

    if (
        buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {

        console.log(
            "PDF DETECTED → QR PDF MODE");

        try {

            const uint8Array = new Uint8Array(buffer);

            const pdf = await getDocument({ data: uint8Array }).promise;

            const maxPages = Math.min(pdf.numPages, 3);

            for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
                console.log(`CHECKING PDF PAGE ${pageNum}`);

                const page = await pdf.getPage(pageNum);

                for (const scale of [2, 3]) {

                    const viewport = page.getViewport({ scale });

                    const canvas = createCanvas(viewport.width, viewport.height);

                    const ctx = canvas.getContext("2d");
                    await page.render({ canvasContext: ctx, viewport }).promise;

                    const imageData = ctx.getImageData(
                        0,
                        0,
                        viewport.width,
                        viewport.height

                    );

                    const code = jsQR(new Uint8ClampedArray(imageData.data),
                        viewport.width,
                        viewport.height
                    );

                    if (code) {

                        console.log("PDF QR FOUND");

                        return code.data;

                    }
                    // TRY LEFT QR CROP

                    const cropX = Math.floor(viewport.width * 0.015);

                    const cropY = Math.floor(viewport.height * 0.18);

                    const cropWidth = Math.floor(viewport.width * 0.16);

                    const cropHeight = Math.floor(viewport.height * 0.28);

                    const tempCanvas = createCanvas(cropWidth * 4, cropHeight * 4);

                    const tempCtx =
                        tempCanvas.getContext("2d");

                    tempCtx.drawImage(
                        canvas,
                        cropX,
                        cropY,
                        cropWidth,
                        cropHeight,
                        0,
                        0,
                        cropWidth * 4,
                        cropHeight * 4

                    );

                    const enhanced = tempCtx.getImageData(0, 0, cropWidth * 4, cropHeight * 4);

                    const croppedCode = jsQR(new Uint8ClampedArray(enhanced.data), cropWidth * 4,
                        cropHeight * 4);

                    if (croppedCode) {

                        console.log("PDF CROPPED QR FOUND");

                        return croppedCode.data;

                    }

                }

            }

            console.log("NO QR FOUND IN PDF");

            return null;

        } catch (err) {
            console.error("PDF QR ERROR:", err.message);
            return null;
        }

    }

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