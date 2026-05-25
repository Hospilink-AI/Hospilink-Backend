const parseDate = (value) => {

    if (!value) return null;

    value = value.toString().trim();

    // DD/MM/YYYY
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {

        const [d, m, y] = value.split("/");

        return new Date(`${y}-${m}-${d}`);
    }

    // DD-MM-YYYY
    if (/^\d{2}-\d{2}-\d{4}$/.test(value)) {

        const [d, m, y] = value.split("-");

        return new Date(`${y}-${m}-${d}`);
    }

    // NORMAL DATE FORMAT
    const parsed = new Date(value);

    if (!isNaN(parsed.getTime())) {
        return parsed;
    }

    return null;
};

exports.isDocumentExpired = (extractedData = {}) => {

    const expiryValue =
        extractedData.validThru ||
        extractedData.validity ||
        extractedData.expiryDate;

    if (!expiryValue) {
        return false;
    }

    const expiryDate = parseDate(expiryValue);

    if (!expiryDate) {
        return false;
    }

    expiryDate.setHours(0, 0, 0, 0);

    const today = new Date();

    today.setHours(0, 0, 0, 0);

    return expiryDate < today;
};