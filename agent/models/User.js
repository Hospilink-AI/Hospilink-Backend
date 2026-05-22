const mongoose = require('mongoose');
const validator = require('validator');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true,
        maxlength: [100, 'Name cannot exceed 100 characters']
    },
    role: {
        type: String,
        required: [true, 'Role is required'],
        enum: {
            values: ['admin', 'candidate', 'hospital', 'staff'],
            message: 'Please select a valid role'
        }
    },
    password: {
        type: String,
        required: [true, 'Password is required'],
        minlength: [6, 'Password must be at least 6 characters long'],
        select: false
    },
    email: {
        type: String,
        required: [true, 'Email is required'],
        unique: true,
        lowercase: true,
        validate: [validator.isEmail, 'Please provide a valid email']
    },
    isEmailVerified: {
        type: Boolean,
        default: false
    },
    otp: {
        code: String,
        expiresAt: Date
    },
    loginDevices: [{
        deviceId: {
            type: String,
            required: true
        },
        deviceName: String,
        ip: String,
        userAgent: String,
        location: {
            city: String,
            region: String,
            country: String
        },
        lastLoginAt: {
            type: Date,
            default: Date.now
        }
    }],
    fcmTokens: {
        type: [{
            token: {
                type: String,
                required: true
            },
            deviceId: String,
            platform: {
                type: String,
                enum: ['android', 'ios', 'web'],
                default: 'android'
            },
            updatedAt: {
                type: Date,
                default: Date.now
            }
        }],
        default: []
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

userSchema.index({ email: 1 });
userSchema.index({ createdAt: -1 });
userSchema.index({ email: 1, isEmailVerified: 1 });
userSchema.index({ role: 1, createdAt: -1 });
userSchema.index({ email: 1, role: 1 });
userSchema.index({ isEmailVerified: 1, createdAt: -1 });
userSchema.index({ _id: 1, role: 1 });
userSchema.index({ email: 1, role: 1, isEmailVerified: 1 });

userSchema.methods.verifyOTP = function (enteredOTP) {
    return this.otp &&
        this.otp.code === enteredOTP &&
        this.otp.expiresAt > new Date();
};

userSchema.methods.clearOTP = function () {
    this.otp = undefined;
    return this.save();
};

userSchema.pre('save', async function (next) {
    if (!this.isModified('password')) return next();
    if (this.password.startsWith('$2')) {
        return next();
    }
    this.password = await bcrypt.hash(this.password, 10);
    next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.model('User', userSchema);
module.exports = User;