const puppeteer = require("puppeteer");

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

exports.verify = async (regNo, name) => {
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ["--no-sandbox"]
        });

        const page = await browser.newPage();

        await page.goto(
            "https://www.nmc.org.in/information-desk/indian-medical-register/",
            { waitUntil: "networkidle2" }
        );

        console.log("👉 Click Advance Search");

        await page.evaluate(() => {
            const el = [...document.querySelectorAll("a")]
                .find(a => a.innerText.includes("Advance Search"));
            el.click();
        });

        await sleep(2000);

        // =========================
        // ✅ USE REAL TYPING (IMPORTANT)
        // =========================

        const inputs = await page.$$("input");

        let nameInput, regInput;

        for (let input of inputs) {
            const placeholder = await page.evaluate(el => el.placeholder, input);

            if (placeholder?.includes("Doctor")) nameInput = input;
            if (placeholder?.includes("Registration")) regInput = input;
        }

        // fallback
        if (!nameInput || !regInput) {
            const visible = [];
            for (let i of inputs) {
                const box = await i.boundingBox();
                if (box) visible.push(i);
            }
            nameInput = visible[0];
            regInput = visible[1];
        }

        // 🔥 IMPORTANT: CLEAR + TYPE (Angular detects this)
        await nameInput.click({ clickCount: 3 });
        await nameInput.press("Backspace");
        await nameInput.type(name, { delay: 50 });

        await regInput.click({ clickCount: 3 });
        await regInput.press("Backspace");
        await regInput.type(String(regNo), { delay: 50 });

        console.log("👉 Click Submit (REAL CLICK)");

        // =========================
        // ✅ CLICK WITH PUPPETEER HANDLE
        // =========================
        const buttons = await page.$$("button");

        let submitBtn;

        for (let btn of buttons) {
            const text = await page.evaluate(el => el.innerText, btn);

            if (text.trim().toLowerCase() === "submit") {
                const box = await btn.boundingBox();
                if (box) {
                    submitBtn = btn;
                    break;
                }
            }
        }

        if (!submitBtn) throw new Error("Submit not found");

        await submitBtn.click();

        // =========================
        // ✅ WAIT FOR RESULT CHANGE (NOT TABLE)
        // =========================

        await sleep(4000);

        const content = await page.content();

        console.log("📄 PAGE SIZE:", content.length);

        await browser.close();

        // =========================
        // ✅ SIMPLE MATCH
        // =========================

        const cleanReg = String(regNo).trim();

        if (content.includes(cleanReg)) {
            return {
                status: "auto-verified",
                source: "nmc"
            };
        }

        return {
            status: "manual-pending-verification"
        };

    } catch (err) {
        console.error("❌ NMC ERROR:", err.message);

        if (browser) await browser.close();

        return {
            status: "manual-pending-verification"
        };
    }
};