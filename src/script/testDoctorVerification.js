require("dotenv").config();

const mongoose = require("mongoose");

const verificationAgent = require("../services/verificationAgent.service");
const detectSystem = require("../utils/systemDetector");

//  CHANGE THESE VALUES FOR TESTING
const TEST_DATA = [
    {
        qualification: "MBBS",
        // registrationNumber: "26674",
        registrationNumber: "G-12843",
        // doctorName: "Sugandhi Sanjay Damodardas"
        doctorName: "Gandhi Sanjaykumar Rasikbhai"
    },
    {

        qualification: "BDS",
        registrationNumber: "A1005",
        doctorName: "Dr. SAUSEELYA ERUSU",
        stateName: "ANDHRA PRADESH"

    },
    {
        qualification: "GNM",
        registrationNumber: "IV-5268",
        doctorName: "Patil Saurabh Satish"
    },
    {
        qualification: "B.PHARM",
        // registrationNumber: "34777",
        // doctorName: "Sanjaykumar Lalbahadur Srivastava"
        registrationNumber: "258524",
        doctorName: "BHIMRAO ASHOK JADHAV"
    }
];

const runTest = async () => {
    try {
        console.log("🚀 Starting Doctor Verification Test...\n");

        for (const data of TEST_DATA) {

            console.log("====================================");
            console.log("INPUT:", data);

            // Step 1: Detect system
            const system = detectSystem({
                reg: data.registrationNumber,
                qualification: data.qualification
            });

            console.log("🔍 DETECTED SYSTEM:", system);

            // Step 2: Run verification agent
            const result = await verificationAgent.verifyDoctor({
                registrationNumber: data.registrationNumber,
                doctorName: data.doctorName,
                qualification: data.qualification,
                stateName: data.stateName
            });

            console.log("✅ RESULT:", result);
            console.log("====================================\n");
        }

        console.log("🎉 Test Completed!");

        process.exit(0);

    } catch (err) {
        console.error("❌ ERROR:", err);
        process.exit(1);
    }
};

runTest();