const mongoose = require("mongoose");
const ncismService = require("../services/ncism.service");

require("dotenv").config();

async function test() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("✅ DB Connected");

        const result = await ncismService.verify(
            "NR/UN/MH/0001118",   // 👈 EXACT from DB
            "Sajid Abdul Samad"   // 👈 partial name (OCR-like)
        );

        console.log("RESULT:", result);

        process.exit();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

test();