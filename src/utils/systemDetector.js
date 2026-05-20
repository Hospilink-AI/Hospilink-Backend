module.exports = ({ reg, qualification }) => {

    const r = (reg || "").toUpperCase();
    const q = (qualification || "").toUpperCase();

    //  REGISTRATION NUMBER 
    if (r.includes("/AY/")) return "AYURVED";
    if (r.includes("/UN/")) return "UNANI";

    //  QUALIFICATION 
    if (q.includes("BAMS")) return "AYURVED";
    if (q.includes("BUMS")) return "UNANI";

    return "UNKNOWN";
};