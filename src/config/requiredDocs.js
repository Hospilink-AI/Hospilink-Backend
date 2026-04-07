module.exports = {
    staff: {
        required: [
            "aadhaar-card",
            "pan-card",
            "license-permit",
            "resume-experience"
        ],
        conditional: [
            ["mcim-certificate", "ncim-certificate"]
        ],
        optional: [
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
