const pdfParse = require("pdf-parse");

const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

const { createCanvas } = require("canvas");

const vision = require("@google-cloud/vision");

const client =
    new vision.ImageAnnotatorClient({

        credentials: {

            client_email:
                process.env
                    .GOOGLE_CLIENT_EMAIL,

            private_key:
                process.env
                    .GOOGLE_PRIVATE_KEY
                    .replace(/\\n/g, "\n")

        }

    });

exports.extractTextFromPDF = async (
    buffer
) => {

    try {

        // STEP 1
        // TRY NORMAL PDF TEXT

        const parsed = await pdfParse(buffer);

        const parsedText = parsed.text?.trim() || "";

        if (parsedText.length > 50) {

            return parsedText;

        }

        // STEP 2
        // OCR SCANNED PDF

        const uint8Array =
            new Uint8Array(buffer);

        const pdf =
            await pdfjsLib
                .getDocument({
                    data: uint8Array
                }).promise;

        let fullText = "";

        const maxPages = Math.min(pdf.numPages, 3);

        for (let pageNum = 1; pageNum <= maxPages; pageNum++) {

            const page = await pdf.getPage(pageNum);

            const viewport = page.getViewport({ scale: 2.5 });

            const canvas = createCanvas(viewport.width, viewport.height);

            const context =
                canvas.getContext("2d");

            await page.render({

                canvasContext: context,

                viewport

            }).promise;

            const imageBuffer =
                canvas.toBuffer("image/png");

            const [result] =
                await client.textDetection({

                    image: {
                        content: imageBuffer
                    }

                });

            const detections =
                result.textAnnotations;

            if (
                detections &&
                detections.length > 0
            ) {

                fullText +=
                    detections[0]
                        .description + "\n";

            }

        }

        return fullText;

    } catch (err) {
        logger.error(`PDF OCR error: ${err.message}`);
        return "";
    }

};