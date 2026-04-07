const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { validateSignup, validateOTP, validateResendOTP, validateSignin } = require('../middleware/validation.middleware');
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
    authController.forgotPassword
);

router.post('/reset-password',
    authRateLimit,
    authController.resetPassword
);


module.exports = router;