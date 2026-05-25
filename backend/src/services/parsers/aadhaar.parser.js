module.exports = (text) => {

    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

    // NAME
    let name;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("DOB") || /\d{2}\/\d{2}\/\d{4}/.test(lines[i])) {
            name = lines[i - 1];
            break;
        }
    }

    if (name) {
        name = name.replace(/[^A-Za-z\s]/g, "").trim();
    }

    // DOB
    const dob = text.match(/\d{2}\/\d{2}\/\d{4}/)?.[0];

    // GENDER
    let gender = text.match(/male|female/i)?.[0];
    if (gender) {
        gender = gender.toLowerCase() === "male" ? "Male" : "Female";
    }

    // AADHAAR NUMBER
    let aadhaarNumber = text.match(/\d{4}\s?\d{4}\s?\d{4}/)?.[0];

    if (aadhaarNumber) {
        aadhaarNumber = aadhaarNumber.replace(/\s/g, "");
        aadhaarNumber = aadhaarNumber.replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3");
    }

    // ADDRESS
    let address = "";

    let rawAddress = text;

    rawAddress = rawAddress
        .replace(/[^A-Za-z0-9,:\-\/\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const startIndex = rawAddress.search(/(S\/O:|D\/O:|C\/O:)/i);

    if (startIndex !== -1) {
        rawAddress = rawAddress.substring(startIndex);
    } else {
        address = ""; 
    }

    // PIN
    const pinIndex = rawAddress.search(/\d{6}/);

    if (pinIndex !== -1) {
        address = rawAddress.substring(0, pinIndex + 6);
    }

    address = address
        .replace(/\b[A-Za-z]{1,2}\b/g, "")   
        .replace(/\b\d{1,2}\b/g, "")         
        .replace(/VID[:\s]*\d+/gi, "")       
        .replace(/\s+/g, " ")
        .trim();

    // FINAL OUTPUT
    return {
        name,
        dob,
        gender,
        aadhaarNumber,
        address
    };
};