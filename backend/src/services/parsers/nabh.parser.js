module.exports = (text = "") => {

    // NORMALIZATION

    const normalized = text
        .replace(/[|]/g, "I")
        .replace(/[—–]/g, "-")
        .replace(/\r/g, "")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{2,}/g, "\n")
        .trim();

    const lines = normalized
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);

    // REMOVE NOISE

    const usefulLines = lines.filter(line =>
        !/national accreditation/i.test(line) &&
        !/quality council/i.test(line) &&
        !/healthcare providers/i.test(line) &&
        !/isqua/i.test(line) &&
        !/phone:/i.test(line) &&
        !/fax/i.test(line) &&
        !/email:/i.test(line) &&
        !/website:/i.test(line) &&
        !/^\W+$/.test(line) &&
        line.length > 2
    );

    // OUTPUT OBJECT

    const data = {
        hcoName: "",
        address: "",
        validFrom: "",
        validThru: "",
        certificateNumber: ""
    };

    // CLEAN FUNCTION

    const clean = (value = "") =>
        value
            .replace(/[^\w\s,&./()-]/g, "")
            .replace(/\s+/g, " ")
            .trim();

    // HOSPITAL NAME EXTRACTION

    let hospitalIndex = -1;

    for (let i = 0; i < usefulLines.length; i++) {

        const line = usefulLines[i];

        if (
            /hospital|healthcare|clinic|centre|center/i.test(line)
        ) {

            // Skip noisy lines
            if (
                /\d{5,}/.test(line) ||
                /certificate/i.test(line) ||
                line.length < 10
            ) {
                continue;
            }

            const cleaned = clean(line);

            if (cleaned.split(" ").length >= 3) {

                data.hcoName = cleaned;
                hospitalIndex = i;
                break;
            }
        }
    }

    // ADDRESS EXTRACTION

    if (hospitalIndex !== -1) {

        const addrLines = [];

        for (
            let j = hospitalIndex + 1;
            j < usefulLines.length;
            j++
        ) {

            const nextLine = usefulLines[j];

            if (!nextLine) break;

            // STOP CONDITIONS
            if (
                /has been assessed/i.test(nextLine) ||
                /entry level/i.test(nextLine) ||
                /requirements/i.test(nextLine) ||
                /valid from/i.test(nextLine) ||
                /certificate no/i.test(nextLine) ||
                /patient safety/i.test(nextLine)
            ) {
                break;
            }

            // Skip OCR junk
            if (
                nextLine.length < 5 ||
                /^[A-Z\s]+Y$/i.test(nextLine)
            ) {
                continue;
            }

            addrLines.push(clean(nextLine));
        }

        data.address = addrLines
            .join(", ")
            .replace(/\s+/g, " ")
            .replace(/,+/g, ",")
            .trim();
    }

    // DATE EXTRACTION

    const validFromMatch = normalized.match(
        /Valid\s*from\s*[:\-]?\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i
    );

    if (validFromMatch) {
        data.validFrom = validFromMatch[1];
    }

    const validThruMatch = normalized.match(
        /Valid\s*thru\s*[:\-]?\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i
    );

    if (validThruMatch) {
        data.validThru = validThruMatch[1];
    }

    // CERTIFICATE NUMBER EXTRACTION

    const certRegexes = [

        /([A-Z]{0,10}HCO-\d{4}-\d{3,6})/i,

        /Certificate\s*No\.?\s*[:\-]?\s*([A-Z0-9\-]+)/i
    ];

    for (const regex of certRegexes) {

        const match = normalized.match(regex);

        if (match) {

            data.certificateNumber = match[1]
                .replace(/\s+/g, "")
                .toUpperCase();

            break;
        }
    }

    // FINAL CLEANUP

    data.hcoName = data.hcoName
        .replace(/\s*&\s*/g, " & ")
        .replace(/\s+/g, " ")
        .trim();

    data.address = data.address
        .replace(/\s+/g, " ")
        .replace(/,+/g, ",")
        .trim();

    console.log("EXTRACTED DATA:", data);

    return data;
};