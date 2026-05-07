const axios = require("axios");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Extract category + number
 * IV-5268 → { category: "IV", number: "5268" }
 */
const parseRegistration = (regNo) => {
    if (!regNo) return { category: "", number: "" };

    const parts = regNo.split("-");

    if (parts.length === 2) {
        return {
            category: parts[0].trim().toUpperCase(),
            number: parts[1].trim()
        };
    }

    return {
        category: "",
        number: regNo.replace(/\D/g, "")
    };
};

exports.verify = async (regNo) => {

    try {
        console.log("🌐 Opening MNC...");

        await sleep(1000);

        const { category, number } = parseRegistration(regNo);

        console.log("📌 Category:", category);
        console.log("📌 Number:", number);

        // ✅ IMPORTANT FIX HERE
        const payload = new URLSearchParams({
            registration_no: number,
            ddlCategory: category || ""   // ✅ correct field name
        });

        const res = await axios.post(
            "https://maharashtranursingcouncil.co.in/mnc/mnc_w17/outer.php?q=nurse_authenticity",
            payload,
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "Mozilla/5.0"
                }
            }
        );

        const html = res.data.toLowerCase().replace(/\s+/g, "");

        console.log("📄 RESPONSE LENGTH:", html.length);

        // =========================
        // ✅ STRICT MATCH
        // =========================

        const found =
            html.includes(number.toLowerCase()) &&
            (category ? html.includes(category.toLowerCase()) : true);

        if (!found) {
            console.log("❌ Not found with category → retry without category");

            // 🔁 fallback retry (important)
            const retry = await axios.post(
                "https://maharashtranursingcouncil.co.in/mnc/mnc_w17/outer.php?q=nurse_authenticity",
                new URLSearchParams({
                    registration_no: number
                }),
                {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        "User-Agent": "Mozilla/5.0"
                    }
                }
            );

            const retryHtml = retry.data.toLowerCase().replace(/\s+/g, "");

            if (!retryHtml.includes(number.toLowerCase())) {
                return {
                    status: "manual-pending-verification"
                };
            }

            console.log("✅ Found in fallback");

            return {
                status: "auto-verified",
                source: "mnc"
            };
        }

        console.log("✅ MNC VERIFIED");

        return {
            status: "auto-verified",
            source: "mnc"
        };

    } catch (err) {
        console.error("❌ MNC ERROR:", err.message);

        return {
            status: "manual-pending-verification"
        };
    }
};