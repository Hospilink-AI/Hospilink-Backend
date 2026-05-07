const puppeteer = require("puppeteer");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// normalize helper
const normalize = (str) =>
    str.toLowerCase().replace(/[^a-z]/g, "");

exports.verify = async (regNo, doctorName = "") => {
    let browser;

    try {
        console.log("🌐 Opening FDA Maharashtra (Puppeteer)...");

        browser = await puppeteer.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox"]
        });

        const page = await browser.newPage();

        await page.goto(
            "https://fdamfg.maharashtra.gov.in/login.aspx",
            { waitUntil: "networkidle2" }
        );

        // =========================
        // 1️⃣ Hover Citizen
        // =========================
        console.log("🔎 Hovering Citizen menu...");

        await page.evaluate(() => {
            const links = [...document.querySelectorAll("a")];
            const citizen = links.find(el =>
                el.innerText.trim().toLowerCase() === "citizen"
            );

            if (citizen) {
                citizen.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
            }
        });

        await sleep(2000);
        console.log("✅ Citizen hover triggered");

        // =========================
        // 2️⃣ Click Pharmacist
        // =========================
        console.log("🔎 Clicking Pharmacist menu...");

        await page.evaluate(() => {
            const links = [...document.querySelectorAll("a")];
            const target = links.find(el =>
                el.innerText.toLowerCase().includes("pharmist")
            );
            if (target) target.click();
        });

        await sleep(3000);
        console.log("✅ Clicked Pharmacist");

        // =========================
        // 3️⃣ Enter Reg No
        // =========================
        console.log("🔎 Entering RegNo...");

        await page.waitForSelector("#txtGrant_No", { timeout: 10000 });

        await page.click("#txtGrant_No", { clickCount: 3 });
        await page.type("#txtGrant_No", regNo.toString());

        console.log("✅ RegNo entered:", regNo);

        // =========================
        // 4️⃣ Click GO
        // =========================
        console.log("🔎 Clicking GO...");

        await page.click("#btnGo");

        await sleep(3000);

        const html = await page.content();
        const lower = html.toLowerCase();

        console.log("📄 RESPONSE LENGTH:", html.length);

        // =========================
        // 🔥 5️⃣ POSITIVE CHECK FIRST
        // =========================

        const pageText = normalize(html);
        const inputName = normalize(doctorName);

        let matches = 0;

        if (doctorName) {
            const words = inputName
                .split(/(?=[A-Z])/)
                .join(" ")
                .split(" ")
                .filter(w => w.length > 3);

            words.forEach(word => {
                if (pageText.includes(word)) matches++;
            });

            console.log("🔍 Name match count:", matches);

            if (matches >= 2) {
                console.log("✅ NAME MATCH FOUND");

                return {
                    status: "auto-verified",
                    source: "fda-maharashtra"
                };
            }
        }

        // ✅ fallback strong indicator
        if (lower.includes("rp=")) {
            console.log("✅ RP ENTRY FOUND");

            return {
                status: "auto-verified",
                source: "fda-maharashtra"
            };
        }

        // =========================
        // ❌ NEGATIVE CHECK LAST
        // =========================
        if (
            lower.includes("not found") ||
            lower.includes("invalid") ||
            lower.includes("no record")
        ) {
            console.log("❌ Not found in FDA");

            return {
                status: "manual-pending-verification"
            };
        }

        console.log("⚠️ Could not confirm match");

        return {
            status: "manual-pending-verification"
        };

    } catch (err) {
        console.error("❌ FDA ERROR:", err.message);

        return {
            status: "manual-pending-verification"
        };

    } finally {
        if (browser) await browser.close();
    }
};