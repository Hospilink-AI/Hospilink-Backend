// const AuthService = require('../services/auth.service');

// class AuthController {
//     async signup(req, res) {
//         try {
//             const result = await AuthService.signup(req.body);
//             res.status(201).json(result);
//         } catch (error) {
//             res.status(400).json({
//                 success: false,
//                 message: error.message
//             });
//         }
//     }

//     async verifyOTP(req, res) {
//         try {
//             const { email, otp } = req.body;
//             const result = await AuthService.verifyOTP(email, otp);
//             res.status(200).json(result);
//         } catch (error) {
//             res.status(400).json({
//                 success: false,
//                 message: error.message
//             });
//         }
//     }

//     async resendOTP(req, res) {
//         try {
//             const { email } = req.body;
//             const result = await AuthService.resendOTP(email);
//             res.status(200).json(result);
//         } catch (error) {
//             res.status(400).json({
//                 success: false,
//                 message: error.message
//             });
//         }
//     }

//     async signin(req, res) {
//         try {
//             const { email } = req.body;
//             const result = await AuthService.signin(email);
//             res.status(200).json(result);
//         } catch (error) {
//             res.status(400).json({
//                 success: false,
//                 message: error.message
//             });
//         }
//     }
// }

// module.exports = new AuthController();




const AuthService = require('../services/auth.service');
const { asyncHandler } = require('../middleware/error.middleware');
const activityLogEmitter = require('../services/activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');

class AuthController {
    signup = asyncHandler(async (req, res) => {
        const result = await AuthService.signup(req.body);
        
        // Log user registration
        if (result.user) {
            const actor = {
                userId: result.user._id || result.user.id,
                name: result.user.name,
                role: result.user.role,
                email: result.user.email
            };
            
            activityLogEmitter.emitUserActivity(
                ACTIVITY_ACTIONS.USER_REGISTERED,
                result.user,
                actor,
                { registrationMethod: 'email' },
                req
            ).catch(err => console.error('Error logging registration:', err));
        }
        
        res.status(201).json({
            success: true,
            ...result
        });
    });

    verifyOTP = asyncHandler(async (req, res) => {
        const { email, otp } = req.body;
        const result = await AuthService.verifyOTP(email, otp);
        
        // Log email verification
        if (result.user) {
            const actor = {
                userId: result.user._id || result.user.id,
                name: result.user.name,
                role: result.user.role,
                email: result.user.email
            };
            
            activityLogEmitter.emitUserActivity(
                ACTIVITY_ACTIONS.EMAIL_VERIFIED,
                result.user,
                actor,
                {},
                req
            ).catch(err => console.error('Error logging email verification:', err));
        }
        
        res.status(200).json({
            success: true,
            ...result
        });
    });

    resendOTP = asyncHandler(async (req, res) => {
        const { email } = req.body;
        const result = await AuthService.resendOTP(email);
        res.status(200).json({
            success: true,
            ...result
        });
    });

    signin = asyncHandler(async (req, res) => {
        const { email, password } = req.body;
        
        try {
            const result = await AuthService.signin(email, password);
            
            // Log successful login
            if (result.user) {
                activityLogEmitter.logUserLogin(result.user, req, true)
                    .catch(err => console.error('Error logging login:', err));
            }
            
            res.status(200).json({
                success: true,
                ...result
            });
        } catch (error) {
            // Log failed login attempt
            activityLogEmitter.emitSecurityActivity(
                ACTIVITY_ACTIONS.USER_LOGIN_FAILED,
                {
                    userId: null,
                    name: 'Unknown',
                    role: 'system',
                    email: email || 'unknown'
                },
                { reason: error.message, attemptedEmail: email },
                req
            ).catch(err => console.error('Error logging failed login:', err));
            
            throw error;
        }
    });

    // logout = asyncHandler(async (req, res) => {
    //     // Since we're using JWT tokens, logout is handled on the client side
    //     // by removing the token from storage. We can add token blacklisting here if needed.
    //     res.status(200).json({
    //         success: true,
    //         message: 'Logged out successfully'
    //     });
    // });

    logout = asyncHandler(async (req, res) => {
        const token = req.headers.authorization?.split(' ')[1];
        const userId = req.user?.id;
        
        // Log logout before processing
        if (req.user) {
            activityLogEmitter.logUserLogout(req.user, req)
                .catch(err => console.error('Error logging logout:', err));
        }
        
        const result = await AuthService.logout(token, userId);
        res.status(200).json({
            success: true,
            ...result
        });
    });

    forgotPassword = asyncHandler(async (req, res) => {
        const { email } = req.body;
        const result = await AuthService.forgotPassword(email);
        
        // Log password reset request
        if (result.user) {
            const actor = {
                userId: result.user._id || result.user.id,
                name: result.user.name,
                role: result.user.role,
                email: result.user.email
            };
            
            activityLogEmitter.emitUserActivity(
                ACTIVITY_ACTIONS.PASSWORD_RESET_REQUESTED,
                result.user,
                actor,
                {},
                req
            ).catch(err => console.error('Error logging password reset request:', err));
        }
        
        res.status(200).json({ success: true, ...result });
    });

    resetPassword = asyncHandler(async (req, res) => {
        const { token, newPassword } = req.body;
        const result = await AuthService.resetPassword(token, newPassword);
        
        // Log password change
        if (result.user) {
            const actor = {
                userId: result.user._id || result.user.id,
                name: result.user.name,
                role: result.user.role,
                email: result.user.email
            };
            
            activityLogEmitter.emitUserActivity(
                ACTIVITY_ACTIONS.PASSWORD_CHANGED,
                result.user,
                actor,
                { method: 'reset_token' },
                req
            ).catch(err => console.error('Error logging password change:', err));
        }
        
        res.status(200).json({ success: true, ...result });
    });
}

module.exports = new AuthController();