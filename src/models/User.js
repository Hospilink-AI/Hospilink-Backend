const mongoose = require('mongoose');
const validator = require('validator');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true,
        maxlength: [50, 'Name cannot exceed 50 characters']
    },
    role: {
        type: String,
        required: [true, 'Role is required'],
        enum: {
            values: ['admin', 'candidate', 'hospital', 'staff'],
            message: 'Please select a valid role'
        }
    },

    // add password
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

    // Track admin login devices for security alerts
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

// Index for faster queries
userSchema.index({ email: 1 });
userSchema.index({ createdAt: -1 });

// Composite indexes for common query patterns
userSchema.index({ email: 1, isEmailVerified: 1 });  // For signin queries
userSchema.index({ role: 1, createdAt: -1 });        // For admin dashboard
userSchema.index({ email: 1, role: 1 });             // For role-based lookups
userSchema.index({ isEmailVerified: 1, createdAt: -1 }); // For cleanup operations

// Additional indexes for profile operations
userSchema.index({ _id: 1, role: 1 });  // For profile lookups
userSchema.index({ email: 1, role: 1, isEmailVerified: 1 }); // Compound index

// Method to compare OTP
userSchema.methods.verifyOTP = function(enteredOTP) {
    return this.otp && 
           this.otp.code === enteredOTP && 
           this.otp.expiresAt > new Date();
};

// Method to clear OTP after verification
userSchema.methods.clearOTP = function() {
    this.otp = undefined;
    return this.save();
};


// hash password middleware
userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();

    // Check if password is already hashed (bcrypt hashes start with $2b$ or $2a$)
    if (this.password.startsWith('$2')) {
        return next(); 
    }
    
    // Hash password with cost of 10
    this.password = await bcrypt.hash(this.password, 10);
    next();
});

// Method to check password
userSchema.methods.comparePassword = async function(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};


const User = mongoose.model('User', userSchema);

module.exports = User;