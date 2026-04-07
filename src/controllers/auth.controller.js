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

class AuthController {
    signup = asyncHandler(async (req, res) => {
        const result = await AuthService.signup(req.body);
        res.status(201).json({
            success: true,
            ...result
        });
    });

    verifyOTP = asyncHandler(async (req, res) => {
        const { email, otp } = req.body;
        const result = await AuthService.verifyOTP(email, otp);
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
        const result = await AuthService.signin(email, password);
        res.status(200).json({
            success: true,
            ...result
        });
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
        
        const result = await AuthService.logout(token, userId);
        res.status(200).json({
            success: true,
            ...result
        });
    });

    forgotPassword = asyncHandler(async (req, res) => {
        const { email } = req.body;
        const result = await AuthService.forgotPassword(email);
        res.status(200).json({ success: true, ...result });
    });

    resetPassword = asyncHandler(async (req, res) => {
        const { token, newPassword } = req.body;
        const result = await AuthService.resetPassword(token, newPassword);
        res.status(200).json({ success: true, ...result });
    });
}

module.exports = new AuthController();