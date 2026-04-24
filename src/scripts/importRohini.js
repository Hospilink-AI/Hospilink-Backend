const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const mongoose = require("mongoose");
const Rohini = require("../models/Rohini");

require("dotenv").config();

async function importCSV() {
    try {
        // WAIT for DB connection
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("MongoDB Connected");

        const results = [];
        const filePath = path.join(__dirname, "rohini 1.csv");

        fs.createReadStream(filePath)
            .pipe(csv())
            .on("data", (data) => {
                // results.push({
                //     rohiniId: (data["sno"] || "")
                //         .toString()
                //         .trim(),

                //     hospitalName: (data["Name"] || "")
                //         .toString()
                //         .toLowerCase()
                //         .trim(),

                //     city: (data["District"] || data["State"] || "")
                //         .toString()
                //         .toLowerCase()
                //         .trim(),

                //     status: "Active"
                // });
                const normalize = (str) =>
                    str
                        .toLowerCase()
                        .replace(/[^a-z0-9 ]/g, "")
                        .replace(/\s+/g, " ")
                        .trim();

                results.push({
                    rohiniId: (data["sno"] || "").toString().trim(),

                    hospitalName: (data["Name"] || "")
                        .toString()
                        .toLowerCase()
                        .trim(),

                    hospitalNameNormalized: normalize(data["Name"] || ""),

                    city: (data["District"] || data["State"] || "")
                        .toString()
                        .toLowerCase()
                        .trim(),

                    status: "Active"
                });
            })
            .on("end", async () => {
                console.log("Total records:", results.length);

                await Rohini.deleteMany({});
                await Rohini.insertMany(results);

                console.log("Rohini CSV Imported Successfully");
                process.exit();
            });

    } catch (err) {
        console.error("Error:", err.message);
        process.exit(1);
    }
}

importCSV();