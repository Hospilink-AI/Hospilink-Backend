module.exports = (text) => {
    const normalized = text
        .replace(/[—–]/g, '-')
        .replace(/[\r\n]+/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .trim();

    let licenseNumber = null;
    let name = null;
    let issueDate = null;
    let expiryDate = null;
    let issuingBody = null;
    let qualification = null;

    // --- DETECT DOCUMENT TYPE ---
    const isMCIM = /maharashtra\s+council\s+of\s+indian\s+medicine/i.test(normalized);
    const isNursingBoard = /registered\s*nurse|nursing\s+board|RN\s*\d/i.test(normalized);
    const isMedicalCouncil = /medical\s+council|MCI|NMC/i.test(normalized);

    // --- LICENSE / REGISTRATION NUMBER ---

    // MCIM format: I-117477-A
    const mcimReg = normalized.match(/I[-\s]?(\d{4,7})[-\s]?[A-Z]/i);
    if (mcimReg) {
        licenseNumber = mcimReg[0].replace(/\s+/g, '').toUpperCase();
    }

    // Nursing board: RN followed by digits
    if (!licenseNumber) {
        const rnMatch = normalized.match(/RN\s?\d{4,}/i);
        if (rnMatch) licenseNumber = rnMatch[0].replace(/\s+/g, '').toUpperCase();
    }

    // Generic: bare registration number near "REG. NO." label
    if (!licenseNumber) {
        const regNoMatch = normalized.match(/(\d{5,7})\s*\n?\s*(?:REG\.?\s*NO\.?)/i);
        if (regNoMatch) licenseNumber = regNoMatch[1];
    }

    // Fallback: any standalone 5-7 digit number
    if (!licenseNumber) {
        const fallback = normalized.match(/\b(\d{5,7})\b/);
        if (fallback) licenseNumber = fallback[1];
    }

    // --- NAME ---
    // "Name : Dr. Sumit Sanjivan Thombre"
    const nameLabelMatch = normalized.match(/Name\s*[:\-]\s*(.+)/i);
    if (nameLabelMatch) {
        name = nameLabelMatch[1].replace(/\s+/g, ' ').trim().split('\n')[0];
    }

    // Fallback: any "Dr." occurrence
    if (!name) {
        const drMatch = normalized.match(/Dr\.?\s+([A-Za-z]+(?: [A-Za-z]+){1,4})/i);
        if (drMatch) name = drMatch[0].trim();
    }

    // Fallback for nursing licenses: uppercase full name line
    if (!name) {
        const lines = normalized.split('\n').map(l => l.trim()).filter(Boolean);
        const candidate = lines.find(l =>
            /^[A-Z\s]{8,}$/.test(l) &&
            l.split(' ').length >= 2 &&
            !/COUNCIL|BOARD|MEDICINE|NURSING|REGISTRATION|CERTIFICATE|GOVERNMENT/i.test(l)
        );
        if (candidate) name = candidate;
    }

    // --- ISSUE DATE ---
    const issueDateMatch = normalized.match(/(?:Registration\s+Date|Issue\s+Date|Issued)\s*[:\-]\s*(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/i);
    if (issueDateMatch) issueDate = issueDateMatch[1].trim();

    // --- EXPIRY DATE ---
    const expiryMatch = normalized.match(/(?:Valid\s+Thru|Expiry|Expires?|Valid\s+Until)\s*[:\-]\s*(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/i);
    if (expiryMatch) expiryDate = expiryMatch[1].trim();

    // --- ISSUING BODY ---
    if (isMCIM) issuingBody = 'Maharashtra Council of Indian Medicine';
    else if (isNursingBoard) issuingBody = 'Nursing Board';
    else if (isMedicalCouncil) issuingBody = 'Medical Council';

    // --- QUALIFICATION ---
    const qualMatch = normalized.match(/Qualification\s*[:\-]\s*([A-Za-z.\s]+)/i);
    if (qualMatch) qualification = qualMatch[1].trim().split('\n')[0].trim();

    return {
        name,
        licenseNumber,
        issueDate,
        expiryDate,
        issuingBody,
        qualification
    };
};
