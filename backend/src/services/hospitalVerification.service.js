const Rohini = require("../models/Rohini");
// const Cghs = require("../models/Cghs");

class HospitalVerificationService {

    async verifyHospital(data) {
        const { certificateNumber, hospitalName, city } = data;

        const name = hospitalName?.toLowerCase().trim();
        const cityName = city?.toLowerCase().trim();

        // STEP 1 - ROHINI
        const rohini = await this.checkRohini(certificateNumber, name, cityName);
        if (rohini) {
            return { status: "auto-verified", source: "rohini" };
        }

        // STEP 2 - CGHS
        // const cghs = await this.checkCghs(certificateNumber, name, cityName);
        // if (cghs) {
        //     return { status: "auto-verified", source: "cghs" };
        // }

        // STEP 3 - NABH
        return { status: "manual-pending-verification", source: "nabh" };
    }

    async checkRohini(id, name, city) {
        console.log("🔍 ROHINI SEARCH:", { id, name, city });

        if (!name) return false;

        const normalize = (str) =>
            str
                .toLowerCase()
                .replace(/[^a-z0-9 ]/g, "")
                .replace(/\s+/g, " ")
                .trim();

        const normalizedName = normalize(name);

        // TEXT SEARCH 
        let match = await Rohini.findOne(
            { $text: { $search: normalizedName }, status: "Active" },
            { score: { $meta: "textScore" } }
        ).sort({ score: { $meta: "textScore" } });

        if (match) return true;

        // NORMALIZED EXACT MATCH
        match = await Rohini.findOne({
            hospitalNameNormalized: normalizedName,
            status: "Active"
        });

        if (match) return true;

        // PARTIAL MATCH
        const words = normalizedName.split(" ");

        match = await Rohini.findOne({
            hospitalNameNormalized: { $regex: words[0], $options: "i" },
            status: "Active"
        });

        return !!match;
    }

    // async checkCghs(id, name, city) {
    //     console.log("CGHS SEARCH:", { id, name, city });

    //     if (id) {
    //         const match = await Cghs.findOne({
    //             cghsId: id.toString().trim(),
    //             status: "Active"
    //         });
    //         if (match) return true;
    //     }

    //     if (!name || !city) return false;

    //     let match = await Cghs.findOne({
    //         hospitalName: name,
    //         city: city,
    //         status: "Active"
    //     });

    //     if (match) return true;

    //     match = await Cghs.findOne({
    //         hospitalName: { $regex: name, $options: "i" },
    //         $or: [
    //             { city: { $regex: city, $options: "i" } },
    //             { city: { $regex: city.split(" ")[0], $options: "i" } }
    //         ],
    //         status: "Active"
    //     });

    //     return !!match;
    // }
}

module.exports = new HospitalVerificationService();