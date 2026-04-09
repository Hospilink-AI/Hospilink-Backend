// const cheerio = require("cheerio");

// module.exports = (text) => {

//     const data = {};

//     // Name
//     const nameMatch = text.match(/Name\s*[:\-]?\s*(Dr\.?\s*[A-Za-z\s]+)/i);
//     if (nameMatch) {
//         data.doctorName = nameMatch[1].trim();
//     }

//     // 🔥 REGISTRATION NUMBER (STRONG FIX)
//     const regMatch = text.match(/I[\s\-]?\d{4,7}[\s\-]?[A-Z]?/i);
//     if (regMatch) {
//         data.registrationNumber = regMatch[0].replace(/\s/g, "");
//     }

//     // Qualification
//     const qualMatch = text.match(/B\.?A\.?M\.?S\.?/i);
//     if (qualMatch) {
//         data.qualification = qualMatch[0];
//     }

//     // DOB
//     const dobMatch = text.match(/\d{2}[-/]\d{2}[-/]\d{4}/);
//     if (dobMatch) {
//         data.dob = dobMatch[0];
//     }

//     // Registration Date
//     const regDateMatch = text.match(/\d{2}\/\d{2}\/\d{4}/);
//     if (regDateMatch) {
//         data.registrationDate = regDateMatch[0];
//     }

//     return data;
// };
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