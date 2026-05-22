exports.compareCertificateData = (ocr, qr) => {

    const normalizeText = (v) =>
        v?.toString().toLowerCase().replace(/[^a-z0-9]/g, "") || "";

    const extractNumber = (v) =>
        v?.toString().replace(/\D/g, "") || "";

    // Name match
    const ocrName = normalizeText(ocr.name);
    const qrName = normalizeText(qr.name);

    const nameMatch =
        ocrName.includes(qrName) ||
        qrName.includes(ocrName);

    // Registration match
    const ocrReg = extractNumber(ocr.registrationNumber);
    const qrReg = extractNumber(qr.registrationNumber);

    const regMatch =
        ocrReg.endsWith(qrReg) ||
        qrReg.endsWith(ocrReg);

    // Final decision
    if (nameMatch && regMatch) return "match";

    if (regMatch) return "partial";

    return "mismatch";
};