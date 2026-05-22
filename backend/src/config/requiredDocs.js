module.exports = {
    staff: {
        required: [
            "aadhaar-card",
            "pan-card",
            "license-permit"
        ],
        conditional: [
            ["mcim-certificate", "ncim-certificate"]
        ],
        optional: [
            "resume-experience",
            "recommendation-letter"
        ]
    },

    hospital: {
        required: [
            "aadhaar-card",
            "pan-card",
            "cin-certificate",
            "gst-certificate"
        ],
        conditional: [
            ["nabh-certificate", "rohini-certificate", "cghs-certificate"]
        ],
        optional: []
    }
};
