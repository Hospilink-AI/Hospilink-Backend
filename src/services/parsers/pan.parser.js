module.exports = (text) => {

    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

    // PAN Number
    const panNumber = text.match(/[A-Z]{5}[0-9]{4}[A-Z]/)?.[0];

    let name, dob;

    for (let i = 0; i < lines.length; i++) {

        // NAME 
        if (/name/i.test(lines[i]) && !/father/i.test(lines[i])) {
            name = lines[i + 1];
        }

        // DOB 
        if (/date of birth|dob/i.test(lines[i])) {
            const dobMatch = lines[i + 1]?.match(/\d{2}[-\/]\d{2}[-\/]\d{4}/);
            if (dobMatch) {
                dob = dobMatch[0];
            }
        }
    }

    if (!dob) {
        const match = text.match(/\d{2}[-\/]\d{2}[-\/]\d{4}/);
        dob = match?.[0];
    }

    if (name) {
        name = name.replace(/[^A-Za-z\s]/g, "").trim();
    }

    return {
        name,
        dob,
        panNumber
    };
};