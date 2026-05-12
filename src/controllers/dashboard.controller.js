const DashboardService = require('../services/dashboard.service');
const { asyncHandler } = require('../middleware/error.middleware');
const MedicalStaff = require('../models/MedicalStaff');


// Staff overview endpoint
exports.getStaffOverview = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const overview = await DashboardService.getStaffOverview(userId);
    
    res.status(200).json({
        success: true,
        data: overview
    });
});


// Staff statistics endpoint
exports.getStaffStats = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const medicalStaff = await MedicalStaff.findOne({ user: userId });
    
    if (!medicalStaff) {
        return res.status(404).json({
            success: false,
            message: 'Medical staff profile not found'
        });
    }
    
    const stats = await DashboardService.getStaffStats(medicalStaff._id);
    
    res.status(200).json({
        success: true,
        data: stats
    });
});


// Upcoming duties endpoint
exports.getUpcomingDuties = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const duties = await DashboardService.getUpcomingDuties(userId);
    
    res.status(200).json({
        success: true,
        count: duties.length,
        data: duties
    });
});


// Earnings information endpoint
exports.getEarnings = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const medicalStaff = await MedicalStaff.findOne({ user: userId });
    
    if (!medicalStaff) {
        return res.status(404).json({
            success: false,
            message: 'Medical staff profile not found'
        });
    }
    
    const earnings = await DashboardService.getEarnings(medicalStaff._id);
    
    res.status(200).json({
        success: true,
        data: earnings
    });
});


// Availability status endpoint
exports.getAvailabilityStatus = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const availability = await DashboardService.getAvailabilityStatus(userId);
    
    res.status(200).json({
        success: true,
        data: availability
    });
});





// Check location permission when accessing dashboard
exports.checkDashboardLocationPermission = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { latitude, longitude, permissionGranted } = req.body;

    const result = await DashboardService.checkDashboardLocationPermission(
        userId,
        { latitude, longitude },
        permissionGranted
    );

    res.status(200).json({
        success: true,
        ...result,
        timestamp: new Date().toISOString()
    });
});

// Update current location on subsequent dashboard visits
exports.updateCurrentLocation = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { latitude, longitude } = req.body;

    const result = await DashboardService.updateCurrentLocation(
        userId,
        { latitude, longitude }
    );

    res.status(200).json({
        success: true,
        ...result,
        timestamp: new Date().toISOString()
    });
});

// Get current location status
exports.getLocationStatus = asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const status = await DashboardService.getCachedLocationPermission(userId);

    res.status(200).json({
        success: true,
        ...status,
        timestamp: new Date().toISOString()
    });
});

