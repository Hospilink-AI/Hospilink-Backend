module.exports = (text) => {

    const lines = text
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);

    let hospitalName = "";
    let location = "";
    let validity = "";
    let rohiniId = "";

    const clean = (v) =>
        v?.replace(/[^\w\s,&.-]/g, "")
            .replace(/\s+/g, " ")
            .trim();

    // ROHINI ID
    const idMatch = text.match(/rohini\s*id[:\s]*([0-9]+)/i);
    if (idMatch) {
        rohiniId = idMatch[1];
    }

    // VALIDITY DATE
    const validMatch = text.match(
        /valid\s*upto[:\s]*([0-9]{1,2}\s+[A-Za-z]{3}\s+[0-9]{4})/i
    );

    if (validMatch) {
        validity = validMatch[1];
    }

    //  HOSPITAL NAME + LOCATION 
    const certLine = lines.find(l =>
        /certify that/i.test(l)
    );

    if (certLine) {

        // extract hospital name
        const nameMatch = certLine.match(/certify that (.+?) located at/i);

        if (nameMatch) {
            hospitalName = clean(nameMatch[1]);
        }

        // extract location
        const locMatch = certLine.match(/located at (.+?) is registered/i);

        if (locMatch) {
            location = clean(locMatch[1]);
        }
    }

    if (!hospitalName || !location) {

        for (let i = 0; i < lines.length; i++) {

            if (/certify that/i.test(lines[i])) {

                const nextLines = lines.slice(i, i + 3).join(" ");

                const nameMatch = nextLines.match(/certify that (.+?) located at/i);
                const locMatch = nextLines.match(/located at (.+?) is registered/i);

                if (nameMatch) hospitalName = clean(nameMatch[1]);
                if (locMatch) location = clean(locMatch[1]);

                break;
            }
        }
    }

    return {
        hospitalName,
        location,
        validity,
        rohiniId
    };
};