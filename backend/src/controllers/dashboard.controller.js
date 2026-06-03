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





// Grant or revoke dashboard location permission (permission flag only).
// Actual coordinates are sent via WebSocket dashboard:location:grant event.
exports.checkDashboardLocationPermission = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { permissionGranted } = req.body;

    if (permissionGranted) {
        await DashboardService.grantDashboardLocationPermission(userId);
        return res.status(200).json({
            success: true,
            permissionGranted: true,
            message: 'Permission granted. Send location via WebSocket dashboard:location:grant event.',
            timestamp: new Date().toISOString()
        });
    }

    await DashboardService.revokeDashboardLocationPermission(userId);
    res.status(200).json({
        success: true,
        permissionGranted: false,
        message: 'Location permission revoked',
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

