module.exports = (text) => {
 
    const lines = text
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);
 
    // NAME
 
    let name = null;
 
    for (let i = 0; i < lines.length; i++) {
 
        const line = lines[i];
 
        if (
            /DOB|Date of Birth/i.test(line)
        ) {
 
            const prevLine = lines[i - 1];
 
            if (
                prevLine &&
                !/Government of India/i.test(prevLine) &&
                !/भारत सरकार/i.test(prevLine)
            ) {
                name = prevLine
                    .replace(/[^A-Za-z\s]/g, "")
                    .replace(/\s+/g, " ")
                    .trim();
            }
 
            break;
        }
    }
 
    // DOB
 
    let dob = null;
 
    const dobMatch =
        text.match(
            /(DOB|Date of Birth)[^\d]*(\d{2}\/\d{2}\/\d{4})/i
        );
 
    if (dobMatch) {
        dob = dobMatch[2];
    }
 
    // fallback
    if (!dob) {
        dob = text.match(/\d{2}\/\d{2}\/\d{4}/)?.[0] || null;
    }
 
    // GENDER
 
    let gender = null;
 
    if (/female/i.test(text)) {
        gender = "Female";
    } else if (/male/i.test(text)) {
        gender = "Male";
    }
 
    // AADHAAR NUMBER
 
    let aadhaarNumber =
        text.match(/\d{4}\s?\d{4}\s?\d{4}/)?.[0];
 
    if (aadhaarNumber) {
        aadhaarNumber = aadhaarNumber
            .replace(/\s/g, "")
            .replace(
                /(\d{4})(\d{4})(\d{4})/,
                "$1 $2 $3"
            );
    }
 
    // ADDRESS
    let address = "";
 
    const addressStart =
        text.search(/(S\/O|D\/O|C\/O)/i);
 
    if (addressStart !== -1) {
 
        let addressText =
            text.substring(addressStart);
 
        const pinMatch =
            addressText.match(/\d{6}/);
 
        if (pinMatch) {
 
            const pinEnd =
                addressText.indexOf(pinMatch[0]) + 6;
 
            address =
                addressText.substring(0, pinEnd);
 
            address = address
                .replace(/\s+/g, " ")
                .trim();
        }
    }
 
    return {
        name,
        dob,
        gender,
        aadhaarNumber,
        address
    };
};