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
// const puppeteer = require("puppeteer");

// exports.verify = async (regNo, name) => {

//     const browser = await puppeteer.launch({
//         headless: true
//     });

//     const page = await browser.newPage();

//     try {
//         await page.goto(
//             "https://www.nmc.org.in/information-desk/indian-medical-register/",
//             { waitUntil: "networkidle2" }
//         );

//         // ✅ Wait for input field properly
//         await page.waitForSelector("input[type='text']");

//         // ✅ Type doctor name (first text input)
//         const inputs = await page.$$("input[type='text']");
//         await inputs[0].type(name);

//         // ✅ Extract captcha (math like "7 + 7")
//         const captchaText = await page.evaluate(() => {
//             const allText = document.body.innerText;
//             const match = allText.match(/(\d+\s*\+\s*\d+)/);
//             return match ? match[0] : null;
//         });

//         if (!captchaText) {
//             throw new Error("Captcha not found");
//         }

//         const answer = eval(captchaText);

//         // ✅ Type captcha answer (second input)
//         await inputs[1].type(answer.toString());

//         // ✅ Click submit (more reliable)
//         const buttons = await page.$$("button");
//         await buttons[0].click();

//         // ✅ Wait for results table
//         await page.waitForSelector("table", { timeout: 5000 });

//         const content = await page.content();

//         if (content.includes(regNo)) {
//             await browser.close();

//             return {
//                 status: "auto-verified",
//                 source: "nmc"
//             };
//         }

//         await browser.close();
//         return { status: "rejected" };

//     } catch (err) {
//         console.error("❌ NMC ERROR:", err.message);

//         await browser.close();

//         return {
//             status: "manual-pending-verification"
//         };
//     }
// };