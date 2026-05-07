const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const mongoose = require("mongoose");
const Ncism = require("../models/NcismRegister");

require("dotenv").config();

// ================= NORMALIZERS =================

// Normalize Registration Number (VERY IMPORTANT)
const normalizeReg = (r) => {
    if (!r) return "";

    let cleaned = r.toString().replace(/\s+/g, "").toUpperCase();

    const digits = cleaned.replace(/\D/g, "");
    const padded = digits.padStart(7, "0");

    if (cleaned.includes("/AY/")) return `NR/AY/MH/${padded}`;
    if (cleaned.includes("/UN/")) return `NR/UN/MH/${padded}`;

    return cleaned;
};

// Normalize Name
const normalizeName = (n) =>
    n
        ?.toString()
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .replace(/\s+/g, " ")
        .trim();

// ================= IMPORT FUNCTION =================

async function importCSV(filePath) {
    let bulk = [];
    let count = 0;
    let skipped = 0;

    return new Promise((resolve, reject) => {

        fs.createReadStream(filePath)
            .pipe(csv())
            .on("data", async (row) => {

                const regRaw =
                    row["National Registration Number"] ||
                    row["National Reg"] ||
                    row["Registration Number"];

                const name =
                    row["Name"] ||
                    row["Name of professional"];

                // 🔥 SKIP INVALID / HEADER ROWS
                if (
                    !regRaw ||
                    !name ||
                    regRaw.toLowerCase().includes("registration") ||
                    name.toLowerCase().includes("name of")
                ) {
                    skipped++;
                    return;
                }

                const reg = normalizeReg(regRaw);

                bulk.push({
                    updateOne: {
                        filter: { registrationNumberNormalized: reg },
                        update: {
                            $set: {
                                registrationNumberNormalized: reg,
                                nameNormalized: normalizeName(name),
                                name,
                                rawRegistrationNumber: regRaw,
                                system: reg.includes("/AY/")
                                    ? "AYURVED"
                                    : "UNANI"
                            }
                        },
                        upsert: true
                    }
                });

                count++;

                // 🔥 BULK INSERT (SAFE)
                if (bulk.length >= 1000) {
                    const temp = bulk;
                    bulk = [];

                    try {
                        await Ncism.bulkWrite(temp);
                    } catch (err) {
                        console.error("❌ Bulk insert error:", err);
                    }
                }
            })
            .on("end", async () => {

                try {
                    // 🔥 FINAL FLUSH
                    if (bulk.length > 0) {
                        await Ncism.bulkWrite(bulk);
                    }

                    console.log(`✅ Imported: ${filePath}`);
                    console.log(`📊 Total records: ${count}`);
                    console.log(`⚠️ Skipped rows: ${skipped}`);

                    resolve();

                } catch (err) {
                    reject(err);
                }
            })
            .on("error", reject);
    });
}

// ================= MAIN RUN =================

(async () => {
    try {
        // ✅ Connect DB (same as Rohini)
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("✅ MongoDB Connected");

        // 🔥 CLEAR OLD DATA
        await Ncism.deleteMany({});
        console.log("🗑️ Old NCISM data cleared");

        // 🔥 IMPORT BOTH FILES
        await importCSV(path.join(__dirname, "unani.csv"));
        await importCSV(path.join(__dirname, "ayurved.csv"));

        console.log("🎉 ALL NCISM DATA IMPORTED SUCCESSFULLY");

        process.exit();

    } catch (err) {
        console.error("❌ ERROR:", err);
        process.exit(1);
    }
})();