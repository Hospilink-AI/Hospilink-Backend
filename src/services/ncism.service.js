const Ncism = require("../models/NcismRegister");

//  NORMALIZERS 
const normalizeReg = (r) => {
    if (!r) return "";

    let cleaned = r.toString().replace(/\s+/g, "").toUpperCase();

    const digits = cleaned.replace(/\D/g, "");
    const padded = digits.padStart(7, "0");

    if (cleaned.includes("/AY/")) return `NR/AY/MH/${padded}`;
    if (cleaned.includes("/UN/")) return `NR/UN/MH/${padded}`;

    return cleaned;
};

const normalizeName = (n) =>
    n
        ?.toString()
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .replace(/\s+/g, " ")
        .trim();

// NAME MATCH 
const isNameMatch = (dbName, inputName) => {
    if (!dbName || !inputName) return false;

    const dbWords = dbName.split(" ");
    const inputWords = inputName.split(" ");

    let matchCount = 0;

    for (let word of inputWords) {
        if (dbWords.includes(word)) {
            matchCount++;
        }
    }

    return matchCount >= Math.ceil(inputWords.length * 0.6);
};

//VERIFY 
exports.verify = async (registrationNumber, doctorName) => {

    const reg = normalizeReg(registrationNumber);
    const name = normalizeName(doctorName);

    console.log("🔍 REG:", reg);
    console.log("🔍 NAME:", name);


    let record = await Ncism.findOne({
        registrationNumberNormalized: reg
    }).lean();

    if (!record) {
        const digits = reg.replace(/\D/g, "");

        record = await Ncism.findOne({
            registrationNumberNormalized: {
                $regex: digits + "$"
            }
        }).lean();
    }

    if (!record) {
        console.log("❌ NOT FOUND");
        return { status: "rejected", reason: "Not found in NCISM DB" };
    }

    console.log("✅ FOUND:", record.name);

    const match = isNameMatch(record.nameNormalized, name);

    return {
        status: match
            ? "auto-verified"
            : "manual-pending-verification",
        source: "ncism-db"
    };
};
