const multer = require("multer");

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    const allowedTypes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "application/pdf"
    ];

    if (!allowedTypes.includes(file.mimetype)) {
        return cb(new Error("Only image files (JPEG, JPG, PNG) or PDF files are allowed"), false);
    }

    cb(null, true);
};

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB for profile pictures
    fileFilter
});

module.exports = upload;