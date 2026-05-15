module.exports = ({ reg, qualification }) => {

    const r = (reg || "").toUpperCase();
    const q = (qualification || "").toUpperCase();

    //  REGISTRATION NUMBER 
    if (r.includes("/AY/")) return "AYURVED";
    if (r.includes("/UN/")) return "UNANI";

    //  QUALIFICATION 
    if (q.includes("BAMS")) return "AYURVED";
    if (q.includes("BUMS")) return "UNANI";

    // MODERN MEDICINE
    if (q.includes("MBBS") || q.includes("MD")) return "NMC";

    //  DENTAL
    if (q.includes("BDS") || q.includes("MDS")) return "DCI";

    // NURSING 
    if (q.includes("NURS") || q.includes("GNM") || q.includes("ANM")) return "MNC";
    
    // PHARMACIST
    if (qualification === "D.PHARM" || qualification === "B.PHARM") {
        return "PHARMACIST";
    }

    return "UNKNOWN";
};