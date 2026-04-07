const mongoose = require('mongoose');
const validator = require('validator');
const bcrypt = require('bcryptjs');

const tempUserSchema = new mongoose.Schema({
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
    password: {
        type: String,
        required: [true, 'Password is required'],
        minlength: [6, 'Password must be at least 6 characters long'],
        select: false
    },
    email: {
        type: String,
        required: [true, 'Email is required'],
        lowercase: true,
        validate: [validator.isEmail, 'Please provide a valid email']
        // Removed 'unique: true' to allow multiple temp users with same email
    },
    otp: {
        code: String,
        expiresAt: Date
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: '1h' // Auto-delete after 1 hour 
    }
}, {
    timestamps: true
});

// Index for faster queries
tempUserSchema.index({ email: 1 });
tempUserSchema.index({ createdAt: -1 });

// Composite indexes for OTP verification and cleanup
tempUserSchema.index({ email: 1, 'otp.expiresAt': 1 });  // For OTP verification
tempUserSchema.index({ 'otp.expiresAt': 1 });           // For expired OTP cleanup
tempUserSchema.index({ email: 1, role: 1 });            // For role-based temp users

// Method to compare OTP
tempUserSchema.methods.verifyOTP = function(enteredOTP) {
    return this.otp && 
           this.otp.code === enteredOTP && 
           this.otp.expiresAt > new Date();
};

// Hash password middleware
tempUserSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return;
    
    // Hash password with cost of 10
    this.password = await bcrypt.hash(this.password, 10);
});

// Method to check password
tempUserSchema.methods.comparePassword = async function(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

const TempUser = mongoose.model('TempUser', tempUserSchema);
module.exports = TempUser;