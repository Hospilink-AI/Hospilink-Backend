const express = require("express");
const router = express.Router();
const controller = require("../controllers/webhook.controller");

router.post("/idfy-aadhaar", controller.handleAadhaarWebhook);

module.exports = router;