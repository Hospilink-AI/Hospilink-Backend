const mongoose = require("mongoose");

const schema = new mongoose.Schema({
    registrationNumberNormalized: {
        type: String,
        required: true,
        unique: true
    },
    nameNormalized: {
        type: String,
        required: true
    },
    name: String,
    system: {
        type: String,
        enum: ["AYURVED", "UNANI"]
    }
});

schema.index({ registrationNumberNormalized: 1 });
schema.index({ nameNormalized: 1 });

module.exports = mongoose.model(
    "NcismRegister",
    schema,
    "ncism_register"
);