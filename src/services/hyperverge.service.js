const axios = require("axios");
const FormData = require("form-data");

const MAX_RETRIES = 3;

const headers = (form) => ({
    ...form.getHeaders(),
    appId: process.env.HYPERVERGE_APP_ID,
    appKey: process.env.HYPERVERGE_API_KEY,
});


// Aadhaar Verification
exports.verifyAadhaar = async (buffer) => {

    let attempt = 0;

    while (attempt < MAX_RETRIES) {

        try {

            const form = new FormData();
            form.append("document", buffer, "aadhaar.jpg");

            const response = await axios.post(
                "https://kyc-api.hyperverge.co/v2/aadhaar",
                form,
                {
                    headers: headers(form),
                    timeout: 10000
                }
            );

            return response.data;

        } catch (error) {

            attempt++;

            if (attempt >= MAX_RETRIES) {
                throw new Error("HyperVerge Aadhaar verification failed");
            }

        }

    }
};


// Document Fraud Detection
exports.checkDocumentFraud = async (buffer) => {

    let attempt = 0;

    while (attempt < MAX_RETRIES) {

        try {

            const form = new FormData();
            form.append("document", buffer, "document.jpg");

            const response = await axios.post(
                "https://kyc-api.hyperverge.co/v2/document-verification",
                form,
                {
                    headers: headers(form),
                    timeout: 10000
                }
            );

            return response.data;

        } catch (error) {

            attempt++;

            if (attempt >= MAX_RETRIES) {
                throw new Error("HyperVerge fraud detection failed");
            }

        }

    }
};