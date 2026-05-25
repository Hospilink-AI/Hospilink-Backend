module.exports = (text) => {

    const lines = text
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);

    let businessName;
    let cin;
    let incorporationDate;

    // CIN NUMBER 
    const cinMatch = text.match(/[A-Z]{1}\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}/);

    if (cinMatch) {
        cin = cinMatch[0];
    }

    // BUSINESS NAME 
    // Look for "PRIVATE LIMITED"
    let nameMatch = text.match(/([A-Z][A-Za-z\s]+PRIVATE LIMITED)/i);

    if (nameMatch) {
        businessName = nameMatch[1]
            .replace(/hereby certify that/i, "") // 🔥 remove noise
            .replace(/is incorporated.*$/i, "")  // 🔥 remove trailing text
            .trim()
            .toUpperCase();
    }

    // fallback: line-based detection
    if (!businessName) {
        const line = lines.find(l =>
            l.toLowerCase().includes("private limited")
        );

        if (line) {
            businessName = line.toUpperCase();
        }
    }

    // INCORPORATION DATE (WORDS → DATE)
    // Extract year
    const yearMatch = text.match(/\b(20\d{2}|19\d{2})\b/);

    if (yearMatch) {
        const year = yearMatch[0];

        // Extract month
        const monthMatch = text.match(
            /January|February|March|April|May|June|July|August|September|October|November|December/i
        );

        const dayMatch = text.match(
            /First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Eleventh|Twelfth|Thirteenth|Fourteenth|Fifteenth|Sixteenth|Seventeenth|Eighteenth|Nineteenth|Twentieth|Twenty[-\s]?First|Twenty[-\s]?Second|Twenty[-\s]?Third|Twenty[-\s]?Fourth|Twenty[-\s]?Fifth|Twenty[-\s]?Sixth|Twenty[-\s]?Seventh|Twenty[-\s]?Eighth|Twenty[-\s]?Ninth|Thirtieth|Thirty[-\s]?First/i
        );

        if (monthMatch && dayMatch) {

            const months = {
                january: "01", february: "02", march: "03",
                april: "04", may: "05", june: "06",
                july: "07", august: "08", september: "09",
                october: "10", november: "11", december: "12"
            };

            const days = {
                first: "01", second: "02", third: "03",
                fourth: "04", fifth: "05", sixth: "06",
                seventh: "07", eighth: "08", ninth: "09",
                tenth: "10", eleventh: "11", twelfth: "12",
                thirteenth: "13", fourteenth: "14", fifteenth: "15",
                sixteenth: "16", seventeenth: "17", eighteenth: "18",
                nineteenth: "19", twentieth: "20",
                "twenty first": "21", "twenty second": "22",
                "twenty third": "23", "twenty fourth": "24",
                "twenty fifth": "25", "twenty sixth": "26",
                "twenty seventh": "27", "twenty eighth": "28",
                "twenty ninth": "29", thirtieth: "30",
                "thirty first": "31"
            };

            const month = months[monthMatch[0].toLowerCase()];
            const dayKey = dayMatch[0].toLowerCase().replace("-", " ");
            const day = days[dayKey];

            if (day && month) {
                incorporationDate = `${day}/${month}/${year}`;
            }
        }
    }

    // FINAL OUTPUT
    return {
        businessName,
        cin,
        incorporationDate
    };
};