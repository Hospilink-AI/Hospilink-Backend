const nmcService = require("./providers/nmc.service");
const dciService = require("./providers/dci.service");
const mncService = require("./providers/mnc.service");
const pharmacistService = require("./providers/fda.service");
const detectSystem = require("../utils/systemDetector");

exports.verifyDoctor = async ({
    registrationNumber,
    doctorName,
    qualification,
    stateName // only used for DCI
}) => {

    const council = detectSystem({
        reg: registrationNumber,
        qualification
    });

    console.log("🎯 COUNCIL:", council);

    try {
        switch (council) {

            case "NMC":
                return await nmcService.verify(
                    registrationNumber,
                    doctorName
                );

            case "DCI":
                // ✅ ONLY CHANGE HERE
                return await dciService.verify(
                    registrationNumber,
                    doctorName,
                    stateName // ✅ pass state ONLY for dental
                );

            case "MNC":
                return await mncService.verify(
                    registrationNumber,
                    doctorName
                );

            case "PHARMACIST":
                return await pharmacistService.verify(registrationNumber, doctorName);

            default:
                return {
                    status: "manual-pending-verification",
                    reason: "Unknown qualification"
                };
        }

    } catch (err) {
        console.error("AGENT ERROR:", err.message);

        return {
            status: "manual-pending-verification",
            reason: "Agent failed"
        };
    }
};