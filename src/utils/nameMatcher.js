const normalizeName = (name = "") => {
    return name
        .toLowerCase()
        .replace(/dr\./g, "")
        .replace(/mr\./g, "")
        .replace(/mrs\./g, "")
        .replace(/ms\./g, "")
        .replace(/[^a-z\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
};

exports.isNameMatched = (profileName, documentName) => {

    const p = normalizeName(profileName);
    const d = normalizeName(documentName);

    if (!p || !d) return false;

    const pWords = p.split(" ");
    const dWords = d.split(" ");

    let matched = 0;

    for (const word of pWords) {
        if (dWords.includes(word)) {
            matched++;
        }
    }

    // 70% match required
    return matched >= Math.ceil(pWords.length * 0.7);
};