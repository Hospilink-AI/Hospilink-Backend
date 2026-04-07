module.exports = (text) => {

    const name = text.match(/Dr\.?\s*([A-Za-z\s]+)/i)?.[1] ||
        text.split("\n").find(l => /^[A-Z\s]{5,}$/.test(l));

    return {
        doctorName: name?.trim(),
        registrationNumber: text.match(/NCIM\s?\d+/i)?.[0]
    };
};