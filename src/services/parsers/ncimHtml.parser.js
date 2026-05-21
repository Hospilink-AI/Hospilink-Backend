const cheerio = require("cheerio");

module.exports = (html) => {

    const $ = cheerio.load(html);

    const data = {};

    $("tr").each((i, row) => {

        const cols = $(row).find("td");

        if (cols.length >= 2) {

            const label = $(cols[0]).text().toLowerCase().trim();
            const value = $(cols[1]).text().trim();

            // Name
            if (
                label.includes("name") ||
                label.includes("nurse")
            ) {
                data.name = value;
            }

            // Registration Number
            if (
                label.includes("registration")
            ) {
                data.registrationNumber = value;
            }

            // Qualification
            if (
                label.includes("qualification")
            ) {
                data.qualification = value;
            }

            // Validity
            if (
                label.includes("valid")
            ) {
                data.validUpto = value;
            }
        }
    });

    return data;
};