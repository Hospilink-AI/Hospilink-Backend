const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
    {
        duty: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Duty",
            required: true
        },

        reviewType: {
            type: String,
            enum: ["hospital_to_staff", "staff_to_hospital"],
            required: true
        },

        hospital: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Hospital",
            required: true
        },

        medicalStaff: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "MedicalStaff",
            required: true
        },

        rating: {
            type: Number,
            required: true,
            min: 1,
            max: 5
        },

        review: {
            type: String,
            trim: true,
            maxlength: 1000
        }

    },
    { timestamps: true }
);

reviewSchema.index({ medicalStaff: 1 });
reviewSchema.index({ duty: 1, reviewType: 1 }, { unique: true });

module.exports = mongoose.model("Review", reviewSchema);