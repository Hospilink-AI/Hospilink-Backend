module.exports = (text) => {

    const lines = text
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);

    let legalName = "";
    let tradeName = "";
    let businessType = "";
    let registrationNumber = "";

    const clean = (value) => {
        if (!value) return "";

        return value
            .replace(/[^A-Za-z\s.&-]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toUpperCase()
            .replace(/\b(LIMITED|LTD|PVT)\s+[A-Z]$/g, "$1")
            .replace(/\b(LIMITED|LTD|PVT)\.$/g, "$1");
    };

    // GST NUMBER
    const gstMatch = text.match(/\d{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}/);
    if (gstMatch) {
        registrationNumber = gstMatch[0];
    }

    // LEGAL NAME
    const legalLine = lines.find(l =>
        l.toLowerCase().includes("legal name")
    );

    if (legalLine) {
        const value = legalLine.replace(/.*legal name[:\s]*/i, "");
        legalName = clean(value);
    }

    // TRADE NAME 
    const tradeLine = lines.find(l =>
        l.toLowerCase().includes("trade name")
    );

    if (tradeLine) {
        const value = tradeLine
            .replace(/.*trade name.*if any[:\s]*/i, "")
            .replace(/.*trade name[:\s]*/i, "");

        tradeName = clean(value);
    }

    // BUSINESS TYPE
    const businessLine = lines.find(l =>
        l.toLowerCase().includes("constitution of business")
    );

    if (businessLine) {
        const value = businessLine.replace(/.*constitution of business[:\s]*/i, "");
        businessType = clean(value);
    }

    if (!businessType) {
        const fallback = lines.find(l =>
            /private limited/i.test(l)
        );

        if (fallback) {
            businessType = "PRIVATE LIMITED COMPANY";
        }
    }

    // //Debug
    // console.log("LINES:", lines);
    // console.log("LEGAL LINE:", legalLine);
    // console.log("TRADE LINE:", tradeLine);

    // FINAL OUTPUT
    return {
        legalName,
        tradeName,
        businessType,
        registrationNumber
    };
};