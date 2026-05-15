const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { 
    validateSignup, 
    validateOTP, 
    validateResendOTP,
    validateSignin, 
    validateForgotPassword, 
    validateResetPassword 
} = require('../middleware/validation.middleware');
const { protect } = require('../middleware/auth.middleware');
const { 
    authRateLimit, 
    otpRateLimit, 
    signupRateLimit,
    generalRateLimit 
} = require('../middleware/rateLimit.middleware');



router.post('/signup', 
    signupRateLimit,
    validateSignup, 
    authController.signup
);

router.post('/verify-otp', 
    otpRateLimit,
    validateOTP, 
    authController.verifyOTP
);

router.post('/resend-otp', 
    otpRateLimit,
    validateResendOTP, 
    authController.resendOTP
);

router.post('/signin', 
    authRateLimit,
    validateSignin, 
    authController.signin
);

router.post('/logout', 
    generalRateLimit,
    protect, 
    authController.logout
);

router.post('/forgot-password',
    authRateLimit,
    validateForgotPassword,
    authController.forgotPassword
);

router.post('/reset-password',
    authRateLimit,
    validateResetPassword,
    authController.resetPassword
);

// FCM Push Notification Routes (Phase 3)
router.post('/fcm-token',
    generalRateLimit,
    protect,
    authController.registerFCMToken
);

router.delete('/fcm-token',
    generalRateLimit,
    protect,
    authController.removeFCMToken
);


module.exports = router;