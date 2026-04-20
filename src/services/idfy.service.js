const axios = require("axios");
const crypto = require("crypto");
const IDFY_BASE_URL = process.env.IDFY_BASE_URL;
const IDFY_API_KEY = process.env.IDFY_API_KEY;
const IDFY_ACCOUNT_ID = process.env.IDFY_ACCOUNT_ID;

const headers = {
    "api-key": IDFY_API_KEY,
    "account-id": IDFY_ACCOUNT_ID,
    "Content-Type": "application/json"
};

// PAN Verification
exports.verifyPAN = async ({ pan, name, dob }) => {
    try {
        const response = await axios.post(
            `${IDFY_BASE_URL}/tasks/async/verify_with_source/ind_pan`,
            {
                task_id: crypto.randomUUID(),
                group_id: crypto.randomUUID(),
                data: {
                    id_number: pan,
                    full_name: name,
                    dob: dob // YYYY-MM-DD
                }
            },
            { headers }
        );

        return response.data; // returns request_id
    } catch (err) {
        console.error("PAN API Error:", err.response?.data || err.message);
        return null;
    }
};

// GST Verification
exports.verifyGST = async (gstin) => {
    try {
        const response = await axios.post(
            `${IDFY_BASE_URL}/tasks/async/verify_with_source/ind_gst_certificate`,
            {
                task_id: crypto.randomUUID(),
                group_id: crypto.randomUUID(),
                data: {
                    gstin: gstin
                }
            },
            { headers }
        );

        return response.data;
    } catch (err) {
        console.error("GST API Error:", err.response?.data || err.message);
        return null;
    }
};

// MCA (CIN) Verification
exports.verifyCIN = async (cin) => {
    try {
        const response = await axios.post(
            `${IDFY_BASE_URL}/tasks/async/verify_with_source/ind_mca`,
            {
                task_id: crypto.randomUUID(),
                group_id: crypto.randomUUID(),
                data: {
                    cin: cin
                }
            },
            { headers }
        );

        return response.data;
    } catch (err) {
        console.error("CIN API Error:", err.response?.data || err.message);
        return null;
    }
};

exports.getTaskResult = async (requestId) => {
    try {
        const response = await axios.get(
            `${IDFY_BASE_URL}/tasks?request_id=${requestId}`,
            { headers }
        );

        return response.data;
    } catch (err) {
        console.error("Fetch Result Error:", err.response?.data || err.message);
        return null;
    }
};