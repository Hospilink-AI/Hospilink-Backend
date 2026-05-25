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
            .replace(/^[.\-:\s]+/, "") // remove leading OCR junk
            .replace(/[^A-Za-z0-9\s.&-]/g, "")
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

    for (let i = 0; i < lines.length; i++) {

        if (lines[i].toLowerCase().includes("legal name")) {

            let value = lines[i]
                .replace(/.*legal name[:\s]*/i, "")
                .trim();

            // next-line fallback for scanned PDFs
            if ((!value || value === "." || value.length <= 2) && lines[i + 1]) {
                value = lines[i + 1];
            }

            console.log("LEGAL CURRENT:", lines[i]);
            console.log("LEGAL NEXT:", lines[i + 1]);
            console.log("LEGAL NEXT 2:", lines[i + 2]);
            console.log("LEGAL NEXT 3:", lines[i + 3]);
            legalName = clean(value);

            // fallback after clean
            if (!legalName || legalName.length <= 2) {

                for (let j = i + 1; j <= i + 5; j++) {

                    if (!lines[j]) continue;

                    const candidate = clean(lines[j]);

                    console.log("LEGAL CANDIDATE:", candidate);

                    // skip table row numbers
                    if (/^\d+\.?$/.test(candidate)) {
                        continue;
                    }

                    // skip labels
                    if (
                        candidate.includes("TRADE NAME") ||
                        candidate.includes("CONSTITUTION") ||
                        candidate.includes("ADDRESS") ||
                        candidate.includes("BUSINESS")
                    ) {
                        continue;
                    }

                    // valid company name found
                    if (
                        candidate.length > 5 &&
                        /LIMITED|PVT|PRIVATE/i.test(candidate)
                    ) {
                        legalName = candidate;
                        break;
                    }
                }
            }

            break;
        }
    }

    // TRADE NAME

    for (let i = 0; i < lines.length; i++) {

        if (lines[i].toLowerCase().includes("trade name")) {

            let value = lines[i]
                .replace(/.*trade name.*if any[:\s]*/i, "")
                .replace(/.*trade name[:\s]*/i, "")
                .trim();

            // next-line fallback for scanned PDFs
            if ((!value || value === "." || value.length <= 2) && lines[i + 1]) {
                value = lines[i + 1];
            }

            tradeName = clean(value);

            // fallback after clean
            if (
                (!tradeName || tradeName === "." || tradeName.length <= 2) &&
                lines[i + 1]
            ) {
                tradeName = clean(lines[i + 1]);
            }

            break;
        }
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