const mongoose = require("mongoose");

const rohiniSchema = new mongoose.Schema({
    rohiniId: { type: String, index: true },
    hospitalName: { type: String, index: true },
    city: { type: String, index: true },
    status: { type: String, index: true } // Active / Inactive
}, { timestamps: true });

// Compound index
rohiniSchema.index({ hospitalName: 1, city: 1 });

module.exports = mongoose
    .connection
    .useDb("Hospital_lookup")
    .model("Rohini", rohiniSchema);