module.exports = (text) => {

    const lines = text
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);

    let hcoName = "";
    let address = "";
    let validFrom = "";
    let validThru = "";
    let certificateNumber = "";

    const clean = (v) =>
        v?.replace(/[^\w\s,.-]/g, "")
         .replace(/\s+/g, " ")
         .trim();

    // REMOVE NOISE LINES
    const usefulLines = lines.filter(l =>
        !/national accreditation/i.test(l) &&
        !/quality council/i.test(l) &&
        !/certificate of accreditation/i.test(l) &&
        !/healthcare providers/i.test(l) &&
        !/^\W+$/.test(l) &&
        l.length > 8
    );

    console.log("USEFUL LINES:\n", usefulLines);

    // SMART HOSPITAL DETECTION
    for (let i = 0; i < usefulLines.length; i++) {

        const line = usefulLines[i];
        if (/hospital|centre/i.test(line)) {
            if (
                /\d{3,}/.test(line) ||                
                /^[^a-zA-Z]*$/.test(line) ||          
                line.length < 15                      
            ) {
                continue;
            }
            const cleaned = clean(line);
            if (
                cleaned.split(" ").length >= 3 &&      
                !/certificate/i.test(cleaned)
            ) {
                hcoName = cleaned;

                //  ADDRESS 
                const addrLines = [];

                for (let j = i + 1; j < i + 5; j++) {
                    const nextLine = usefulLines[j];

                    if (!nextLine) break;

                    if (
                        /has been assessed/i.test(nextLine) ||
                        /valid from/i.test(nextLine)
                    ) break;

                    addrLines.push(clean(nextLine));
                }

                address = addrLines.join(", ");
                break;
            }
        }
    }

    // DATE EXTRACTION
    const dateRegex = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/gi;

    const allDates = text.match(dateRegex) || [];

    if (allDates.length >= 2) {
        validFrom = allDates[allDates.length - 2];
        validThru = allDates[allDates.length - 1];
    }

    // CERTIFICATE NUMBER
    const certMatch = text.match(/[A-Z]{1,3}-\d{4}-\d{3,4}/);

    if (certMatch) {
        certificateNumber = certMatch[0];
    }

    // FINAL OUTPUT
    return {
        hcoName,
        address,
        validFrom,
        validThru,
        certificateNumber
    };
};