const cheerio = require("cheerio");

module.exports = (html) => {
    const $ = cheerio.load(html);

    const data = {};

    $("tr").each((i, row) => {
        const cols = $(row).find("td");

        if (cols.length >= 2) {
            const label = $(cols[0]).text().toLowerCase().trim();
            const value = $(cols[1]).text().trim();

            if (label.includes("doctor")) {
                data.name = value;
            }

            if (label.includes("registration")) {
                data.registrationNumber = value;
            }

            if (label.includes("valid")) {
                data.validUpto = value;
            }
        }
    });

    return data;
};