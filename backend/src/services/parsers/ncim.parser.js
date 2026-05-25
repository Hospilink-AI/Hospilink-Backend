module.exports = (text) => {

    const normalized = text
        .replace(/[—–]/g, "-")
        .replace(/[\r\n]+/g, "\n")
        .replace(/[ \t]+/g, " ")
        .trim();

    let doctorName = null;
    let registrationNumber = null;
    let qualification = null;
    let validThru = null;

    const nameMatch =
        normalized.match(/MR\.?\s+[A-Z\s]+/i) ||
        normalized.match(/MS\.?\s+[A-Z\s]+/i) ||
        normalized.match(/MRS\.?\s+[A-Z\s]+/i);

    if (nameMatch) {
        doctorName = nameMatch[0]
            .replace(/\s+/g, " ")
            .trim();
    }

    const regMatch = normalized.match(
        /(?:Registration\s*No\.?|Reg\.?\s*No\.?)\s*[:\-]?\s*([A-Z\-0-9]+)/i
    );

    if (regMatch) {
        registrationNumber = regMatch[1].trim();
    }

    // fallback for registration number 
    if (!registrationNumber) {

        const fallbackReg = normalized.match(
            /\b[A-Z]{1,4}[- ]?\d{3,8}[- ]?[A-Z]?\b/i
        );

        if (fallbackReg) {
            registrationNumber = fallbackReg[0]
                .replace(/\s+/g, "")
                .toUpperCase();
        }
    }

    const qualMatch = normalized.match(
        /(B\.?\s*SC\.?\s*NURSING.*?|GNM|ANM|MIDWIFERY)/i
    );

    if (qualMatch) {
        qualification = qualMatch[0].trim();
    }

    const validMatch = normalized.match(
        /Valid\s*Upto\s*(\d{2}\/\d{2}\/\d{4})/i
    );

    if (validMatch) {
        validThru = validMatch[1];
    }

    return {
        doctorName,
        registrationNumber,
        qualification,
        validThru
    };
};