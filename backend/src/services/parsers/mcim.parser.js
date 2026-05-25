module.exports = (text) => {
    // Normalize: collapse multiple spaces, unify line endings
    const normalized = text
        .replace(/[—–]/g, '-')
        .replace(/[\r\n]+/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .trim();

    const lines = normalized.split('\n').map(l => l.trim()).filter(Boolean);

    let doctorName = null;
    let registrationNumber = null;
    let qualification = null;
    let dob = null;
    let validThru = null;
    let registrationDate = null;

    // --- REGISTRATION NUMBER ---
    // Format on card: "I-117477-A" (printed as REG. NO.)
    // OCR may also see the bare number "117477" above it
    const regFull = normalized.match(/[I1][-\s]?(\d{4,7})[-\s]?[A-Z]/i);
    if (regFull) {
        registrationNumber = regFull[0].replace(/\s+/g, '').replace(/^1-/, 'I-').toUpperCase();
    } else {
        // fallback: bare number near "REG" keyword
        const regBare = normalized.match(/(\d{5,7})\s*\n?\s*(?:REG\.?\s*NO\.?|I-)/i);
        if (regBare) {
            registrationNumber = `I-${regBare[1]}-A`;
        }
    }

    // --- DOCTOR NAME ---
    // Card layout: "Name   : Dr. Sumit Sanjivan Thombre"
    const nameLineMatch = normalized.match(/Name\s*[:\-]\s*(.+)/i);
    if (nameLineMatch) {
        doctorName = nameLineMatch[1]
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Fallback: any "Dr." occurrence
    if (!doctorName) {
        const drMatch = normalized.match(/Dr\.?\s+([A-Za-z]+(?: [A-Za-z]+){1,4})/i);
        if (drMatch) {
            doctorName = drMatch[0].trim();
        }
    }

    // --- QUALIFICATION ---
    const qualMatch = normalized.match(/Qualification\s*[:\-]\s*([A-Za-z.\s]+)/i);
    if (qualMatch) {
        qualification = qualMatch[1].trim().split('\n')[0].trim();
    }

    // --- DOB ---
    const dobMatch = normalized.match(/DOB\s*[:\-]\s*(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/i);
    if (dobMatch) {
        dob = dobMatch[1].trim();
    }

    // --- REGISTRATION DATE ---
    const regDateMatch = normalized.match(/Registration\s+Date\s*[:\-]\s*(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/i);
    if (regDateMatch) {
        registrationDate = regDateMatch[1].trim();
    }

    // --- VALID THRU ---
    const validMatch = normalized.match(/(?:Valid\s*Thru|Valid\s*Upto|Valid\s*Until|Validity)\s*[:\-]?\s*(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/i);
    if (validMatch) {
        validThru = validMatch[1].trim();
    }

    return {
        doctorName,
        registrationNumber,
        qualification,
        dob,
        registrationDate,
        validThru
    };
};
