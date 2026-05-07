const axios = require("axios");
const cheerio = require("cheerio");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 🔹 Map your states (important)
const STATE_MAP = {
    "ANDHRA PRADESH": "1",
    "ARUNACHAL PRADESH": "2",
    "ASSAM": "3",
    "BIHAR": "4",
    "CHHATISGARH": "5",
    "CHANDIGARH": "6",
    "DELHI": "7",
    "GOA": "8",
    "GUJARAT": "9",
    "HARYANA": "10",
    "HIMACHAL PRADESH": "11",
    "JHARKHAND": "12",
    "J&K": "13",
    "KARNATAKA": "14",
    "KERALA": "15",
    "MADHYA PRADESH": "16",
    "MAHARASHTRA": "17",
    "MEGHALAYA": "18",
    "MIZORAM": "19",
    "MANIPUR": "20",
    "NAGALAND": "21",
    "ODISHA": "22",
    "PUDUCHERRY": "23",
    "PUNJAB": "24",
    "RAJASTHAN": "25",
    "SIKKIM": "26",
    "TAMIL NADU": "27",
    "TRIPURA": "28",
    "TELANGANA": "29",
    "UTTAR PRADESH": "30",
    "UTTARAKHAND": "31",
    "WEST BENGAL": "32"
};

exports.verify = async (regNo, doctorName, stateName = null) => {
    try {
        console.log("🌐 Opening DCI...");

        // =========================
        // 1️⃣ GET page
        // =========================
        const page = await axios.get(
            "https://dciindia.gov.in/DentistDetails.aspx",
            { headers: { "User-Agent": "Mozilla/5.0" } }
        );

        const cookies = page.headers["set-cookie"];
        const $ = cheerio.load(page.data);

        const viewState = $("#__VIEWSTATE").val();
        const eventValidation = $("#__EVENTVALIDATION").val();
        const viewStateGen = $("#__VIEWSTATEGENERATOR").val();

        // =========================
        // 2️⃣ Clean inputs
        // =========================
        const cleanReg = regNo.replace(/\s+/g, "").toUpperCase();
        const cleanName = doctorName
            ? doctorName.toLowerCase().replace("dr.", "").trim()
            : "";

        // =========================
        // 3️⃣ Get state code
        // =========================
        let stateCode = "0"; // default = ALL

        if (stateName) {
            const key = stateName.toUpperCase();
            if (STATE_MAP[key]) {
                stateCode = STATE_MAP[key];
            }
        }

        console.log("📌 Using State:", stateCode);

        await sleep(800);

        // =========================
        // 4️⃣ POST request
        // =========================
        const res = await axios.post(
            "https://dciindia.gov.in/DentistDetails.aspx",
            new URLSearchParams({
                "__VIEWSTATE": viewState,
                "__VIEWSTATEGENERATOR": viewStateGen,
                "__EVENTVALIDATION": eventValidation,

                "ctl00$ContentPlaceHolder1$txtName": cleanName,
                "ctl00$ContentPlaceHolder1$txtRegNo": cleanReg,
                "ctl00$ContentPlaceHolder1$ddlSDC": stateCode,

                "ctl00$ContentPlaceHolder1$btnSearch": "Search"
            }),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "Mozilla/5.0",
                    "Referer": "https://dciindia.gov.in/DentistDetails.aspx",
                    "Origin": "https://dciindia.gov.in",
                    "Cookie": cookies.join(";")
                }
            }
        );

        const $$ = cheerio.load(res.data);

        // =========================
        // 5️⃣ Direct row match
        // =========================
        const rows = $$("table tr").toArray();

        const matchRow = rows.find((el) => {
            const cols = $$(el).find("td");

            if (cols.length >= 3) {
                const reg = $$(cols[2])
                    .text()
                    .replace(/\s+/g, "")
                    .toUpperCase();

                return reg === cleanReg;
            }
            return false;
        });

        // =========================
        // 6️⃣ Result handling
        // =========================
        if (!matchRow) {
            console.log("❌ Not found");
            return { status: "manual-pending-verification" };
        }

        const cols = $$(matchRow).find("td");

        const foundName = $$(cols[1])
            .text()
            .toLowerCase()
            .replace("dr.", "")
            .trim();

        console.log("✅ FOUND:", foundName, cleanReg);

        const firstToken = cleanName.split(" ")[0];

        const nameMatch = firstToken
            ? foundName.includes(firstToken)
            : true;

        return {
            status: nameMatch
                ? "auto-verified"
                : "manual-pending-verification",
            source: "dci"
        };

    } catch (err) {
        console.error("❌ DCI ERROR:", err.message);

        return {
            status: "manual-pending-verification"
        };
    }
};