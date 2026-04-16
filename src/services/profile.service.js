const MedicalStaff = require('../models/MedicalStaff');
const Hospital = require('../models/Hospital');
const User = require('../models/User');
const geocodingService = require('../services/geocoding.service');
const cacheService = require('./cache.service');
// const { toRadians } = require('../utils/helpers');
const documentService = require('./document.service');
const Review = require('../models/Review');
const path = require('path');
const { uploadToS3, deleteFromS3, generatePreSignedURL } = require('./s3.service');

class ProfileService {
    // Create medical staff profile
    async createMedicalStaffProfile(userId, profileData) {
        try {
            // Check if user exists and has staff role
            const user = await User.findById(userId);
            if (!user) {
                throw new Error('User not found');
            }

            if (user.role !== 'staff') {
                throw new Error('User must have staff role to create medical staff profile');
            }

            // Check if profile already exists
            const existingProfile = await MedicalStaff.findOne({ user: userId });
            if (existingProfile) {
                throw new Error('Medical staff profile already exists');
            }

            let coordinates = null;

            // Always geocode from address - no location permission during profile creation
            const address = `${profileData.area}, ${profileData.city}`;
            try {
                const geocoded = await geocodingService.geocodeAddress(address);
                coordinates = {
                    type: 'Point',
                    coordinates: {
                        latitude: geocoded.latitude,
                        longitude: geocoded.longitude
                    }
                };
                console.log('Geocoded from address for staff profile:', coordinates);
            } catch (error) {
                console.error('Geocoding failed for staff profile:', error.message);
                throw new Error('Failed to geocode location. Please provide valid city and area.');
            }

            // Validate coordinates
            geocodingService.validateCoordinates(coordinates.coordinates.latitude, coordinates.coordinates.longitude);

            // Create medical staff profile with all required fields
            const medicalStaffProfile = new MedicalStaff({
                user: userId,
                fullName: profileData.fullName || user.name,
                jobRole: profileData.jobRole,
                city: profileData.city,
                area: profileData.area,
                phoneNumber: profileData.phoneNumber,
                coordinates: coordinates,
                profileSummary: profileData.profileSummary || '',
                education: profileData.education || [],
                skills: profileData.skills || []
            });

            await medicalStaffProfile.save();

            // Populate user data
            await medicalStaffProfile.populate('user', 'name email role isEmailVerified');

            await cacheService.setProfile(userId, 'staff', medicalStaffProfile.toObject());

            // Invalidate profile status cache
            await cacheService.invalidateProfileStatus(userId);

            // Invalidate location permission cache
            await cacheService.del(`location:permission:${userId}`);

            // Emit notification to admins about new staff registration
            try {
                const notificationEmitter = require('./notificationEmitter');
                const user = await User.findById(userId);
                await notificationEmitter.emitNewStaffRegistration(medicalStaffProfile, user);
            } catch (notifError) {
                console.error('Error sending staff registration notification:', notifError);
                // Don't fail the registration if notification fails
            }

            return {
                success: true,
                profile: medicalStaffProfile,
                locationSource: 'address_geocoded',
                message: 'Medical staff profile created successfully'
            };
        } catch (error) {
            throw new Error(error.message);
        }
    }

    // Create hospital profile
    async createHospitalProfile(userId, profileData) {
        try {
            // Check if user exists and has hospital role
            const user = await User.findById(userId);
            if (!user) {
                throw new Error('User not found');
            }

            if (user.role !== 'hospital') {
                throw new Error('User must have hospital role to create hospital profile');
            }

            // Check if profile already exists
            const existingProfile = await Hospital.findOne({ user: userId });
            if (existingProfile) {
                throw new Error('Hospital profile already exists');
            }

            let coordinates;
            let geocodingAddress;
            let geocodingSource = 'google_maps_api';

            // Build comprehensive address for geocoding using all three fields
            const addressParts = [
                profileData.hospitalLegalName,
                profileData.currentAddress,
                profileData.location
            ].filter(part => part && part.trim() !== '');

            geocodingAddress = addressParts.join(', ');
            console.log('Comprehensive geocoding address:', geocodingAddress);

            // Geocode the hospital address
            try {
                const geocoded = await geocodingService.geocodeAddress(geocodingAddress);
                coordinates = {
                    type: 'Point',
                    coordinates: {
                        longitude: geocoded.longitude,
                        latitude: geocoded.latitude
                    }
                };
                console.log('Hospital geocoded successfully:', coordinates);
            } catch (error) {
                console.error('Hospital geocoding failed:', error.message);

                // Try with simplified address (hospital name + location)
                try {
                    const simplifiedAddress = `${profileData.hospitalLegalName}, ${profileData.location}`;
                    console.log('Retrying with simplified address:', simplifiedAddress);

                    const geocoded = await geocodingService.geocodeAddress(simplifiedAddress);
                    coordinates = {
                        type: 'Point',
                        coordinates: {
                            longitude: geocoded.longitude,
                            latitude: geocoded.latitude
                        }
                    };
                    console.log('Retry geocoding successful:', coordinates);
                    geocodingAddress = simplifiedAddress;
                } catch (retryError) {
                    console.error('Retry geocoding also failed:', retryError.message);

                    // Final fallback - just hospital name + city
                    try {
                        const fallbackAddress = `${profileData.hospitalLegalName}, ${profileData.location || 'India'}`;
                        console.log('Final fallback with:', fallbackAddress);

                        const geocoded = await geocodingService.geocodeAddress(fallbackAddress);
                        coordinates = {
                            type: 'Point',
                            coordinates: {
                                longitude: geocoded.longitude,
                                latitude: geocoded.latitude
                            }
                        };
                        console.log('Fallback geocoding successful:', coordinates);
                        geocodingAddress = fallbackAddress;
                    } catch (finalError) {
                        console.error('All geocoding attempts failed:', finalError.message);
                        throw new Error(`Failed to geocode hospital location. Please check your address details. Error: ${finalError.message}`);
                    }
                }
            }

            // Create hospital profile with both location string and coordinates
            const hospitalProfile = new Hospital({
                user: userId,
                hospitalLegalName: profileData.hospitalLegalName,
                currentAddress: profileData.currentAddress,
                location: profileData.location,
                servicesAvailable: profileData.servicesAvailable,
                staffCount: profileData.staffCount,
                coordinates: coordinates // Store coordinates with named properties
            });

            await hospitalProfile.save();

            // Populate user data
            await hospitalProfile.populate('user', 'name email role isEmailVerified');

            await cacheService.setProfile(userId, 'hospital', hospitalProfile.toObject());

            // Invalidate profile status cache
            await cacheService.invalidateProfileStatus(userId);

            // Emit notification to admins about new hospital registration
            try {
                const notificationEmitter = require('./notificationEmitter');
                const user = await User.findById(userId);
                await notificationEmitter.emitNewHospitalRegistration(hospitalProfile, user);
            } catch (notifError) {
                console.error('Error sending hospital registration notification:', notifError);
                // Don't fail the registration if notification fails
            }

            return {
                success: true,
                profile: hospitalProfile,
                geocodingAddress: geocodingAddress,
                geocodingSource: geocodingSource,
                message: 'Hospital profile created successfully'
            };
        } catch (error) {
            throw new Error(error.message);
        }
    }

    // Get user profile based on role
    async getUserProfile(userId) {
        try {
            const user = await User.findById(userId).select('name email role isEmailVerified').lean();
            if (!user) throw new Error('User not found');

            // Check cache first
            const cachedProfile = await cacheService.getProfile(userId, user.role);
            if (cachedProfile) return cachedProfile;

            // Use aggregation for single query
            let profile = null;

            if (user.role === 'staff') {
                const raw = await MedicalStaff.findOne({ user: userId }).lean();
                if (raw) {
                    const Duty = require('../models/Duty');
                    const Document = require('../models/Document');
                    let profilePictureUrl = null;

                    // Generate presigned URL for profile picture
                    if (raw.profilePicture?.s3Key) {
                        try {
                            profilePictureUrl = await generatePreSignedURL(raw.profilePicture.s3Key);
                        } catch (error) {
                            console.error('Failed to generate profile picture URL:', error.message);
                        }
                    }

                    const [activeApplications, docRecord] = await Promise.all([
                        Duty.countDocuments({
                            assignedTo: raw._id,
                            status: { $in: ['assigned', 'enroute', 'in-progress'] }
                        }),
                        Document.findOne({ userId }).lean()
                    ]);

                    // Verified docs count
                    const verifiedDocs = docRecord
                        ? docRecord.documents.filter(
                            d => !d.isDeleted && d.verificationStatus === 'verified'
                        ).length
                        : 0;

                    // Profile completion %
                    const completionFields = [
                        raw.fullName, raw.jobRole, raw.city, raw.area,
                        raw.phoneNumber, raw.profileSummary,
                        raw.education?.length > 0,
                        raw.skills?.length > 0,
                        raw.coordinates?.coordinates?.latitude
                    ];
                    const filled = completionFields.filter(Boolean).length;
                    const profileCompletion = Math.round((filled / completionFields.length) * 100);

                    profile = {
                        id: raw._id,
                        fullName: raw.fullName,
                        profilePicture: profilePictureUrl,
                        jobRole: raw.jobRole,
                        city: raw.city,
                        area: raw.area,
                        phoneNumber: raw.phoneNumber,
                        profileSummary: raw.profileSummary || '',
                        education: raw.education || [],
                        skills: raw.skills || [],
                        isAvailable: raw.isAvailable,
                        isProfileComplete: raw.isProfileComplete,
                        profileCompletion,
                        activeApplications,
                        verifiedDocs,
                        totalExperience: raw.totalExperience || 0,
                        averageRating: raw.averageRating,
                        totalRatings: raw.totalRatings,
                        location: {
                            latitude: raw.coordinates?.coordinates?.latitude,
                            longitude: raw.coordinates?.coordinates?.longitude
                        },
                        createdAt: raw.createdAt,
                        updatedAt: raw.updatedAt
                    };
                }
            } else if (user.role === 'hospital') {
                const raw = await Hospital.findOne({ user: userId }).lean();
                if (raw) {
                    let profilePictureUrl = null;

                    // Generate presigned URL for profile picture
                    if (raw.profilePicture?.s3Key) {
                        try {
                            profilePictureUrl = await generatePreSignedURL(raw.profilePicture.s3Key);
                        } catch (error) {
                            console.error('Failed to generate profile picture URL:', error.message);
                        }
                    }
                    profile = {
                        id: raw._id,
                        hospitalLegalName: raw.hospitalLegalName,
                        profilePicture: profilePictureUrl,
                        currentAddress: raw.currentAddress,
                        location: raw.location,
                        servicesAvailable: raw.servicesAvailable,
                        isProfileComplete: raw.isProfileComplete,
                        staffCount: raw.staffCount,
                        coordinates: {
                            latitude: raw.coordinates?.coordinates?.latitude,
                            longitude: raw.coordinates?.coordinates?.longitude
                        },
                        createdAt: raw.createdAt,
                        updatedAt: raw.updatedAt
                    };
                }
            }

            let documents = [];
            try {
                const documentsData = await documentService.getUserDocuments(user, { page: 1, limit: 50 });
                documents = documentsData.documents.map(doc => ({
                    id: doc.documentId,
                    documentType: doc.documentType,
                    verificationStatus: doc.verificationStatus,
                    fileName: doc.fileName,
                    uploadedAt: doc.uploadedAt,
                    url: doc.url
                }));
            } catch (err) {
                console.error("Error fetching documents:", err.message);
            }

            const result = {
                user: {
                    id: user._id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    isEmailVerified: user.isEmailVerified
                },
                profile,
                documents
            };

            // Cache for 15 minutes
            await cacheService.setProfile(userId, user.role, result);

            return result;
        } catch (error) {
            throw new Error(error.message);
        }
    }

    // Update user profile with location handling
    async updateUserProfile(userId, updateData) {
        try {
            const cacheService = require('./cache.service');

            // Get user with lean query
            const user = await User.findById(userId).select('name email role').lean();
            if (!user) {
                throw new Error('User not found');
            }

            let updatedProfile = null;
            let userUpdateData = {};

            if (user.role === 'staff') {
                // Get current staff profile with lean query
                const currentProfile = await MedicalStaff.findOne({ user: userId }).lean();

                if (!currentProfile) {
                    throw new Error('Staff profile not found');
                }

                let finalUpdateData = { ...updateData };

                // Check if location fields changed
                const cityChanged = updateData.city && updateData.city !== currentProfile.city;
                const areaChanged = updateData.area && updateData.area !== currentProfile.area;

                // Handle optional fields update safely
                if (updateData.profileSummary !== undefined) {
                    finalUpdateData.profileSummary = updateData.profileSummary;
                }

                if (Array.isArray(updateData.education)) {
                    finalUpdateData.education = updateData.education;
                }

                if (Array.isArray(updateData.skills)) {
                    finalUpdateData.skills = updateData.skills;
                }

                // Only geocode if location fields actually changed
                if (cityChanged || areaChanged) {
                    if (!updateData.coordinates || !updateData.coordinates.latitude || !updateData.coordinates.longitude) {
                        const address = `${updateData.area || currentProfile.area}, ${updateData.city || currentProfile.city}`;

                        // Try cache first
                        const cachedGeocoding = await cacheService.getGeocoding(address);
                        if (cachedGeocoding) {
                            finalUpdateData.coordinates = {
                                type: 'Point',
                                coordinates: {
                                    latitude: cachedGeocoding.latitude,
                                    longitude: cachedGeocoding.longitude
                                }
                            };
                        } else {
                            // Geocode and cache result
                            const geocodingService = require('../services/geocoding.service');
                            const geocoded = await geocodingService.geocodeAddress(address);
                            finalUpdateData.coordinates = {
                                type: 'Point',
                                coordinates: {
                                    latitude: geocoded.latitude,
                                    longitude: geocoded.longitude
                                }
                            };

                            // Cache geocoding result
                            await cacheService.setGeocoding(address, geocoded);
                        }
                    } else {
                        // Validate provided coordinates
                        const geocodingService = require('../services/geocoding.service');
                        geocodingService.validateCoordinates(
                            updateData.coordinates.latitude,
                            updateData.coordinates.longitude
                        );
                    }
                }

                // Update profile with lean options
                updatedProfile = await MedicalStaff.findOneAndUpdate(
                    { user: userId },
                    { ...finalUpdateData, updatedAt: new Date() },
                    {
                        new: true,
                        runValidators: true,
                        lean: true
                    }
                );

                // Update user name if changed
                if (updateData.fullName && updateData.fullName !== user.name) {
                    userUpdateData.name = updateData.fullName;
                }

            } else if (user.role === 'hospital') {
                // Similar optimized approach for hospital profiles
                const currentProfile = await Hospital.findOne({ user: userId }).lean();

                if (!currentProfile) {
                    throw new Error('Hospital profile not found');
                }

                let finalUpdateData = { ...updateData };

                // Handle location changes with caching
                const locationChanged = updateData.location && updateData.location !== currentProfile.location;

                if (locationChanged) {
                    const locationToGeocode = updateData.location || currentProfile.location;

                    if (locationToGeocode) {
                        // Try cache first
                        const cachedGeocoding = await cacheService.getGeocoding(locationToGeocode);
                        if (cachedGeocoding) {
                            finalUpdateData.coordinates = {
                                type: 'Point',
                                coordinates: {
                                    latitude: cachedGeocoding.latitude,
                                    longitude: cachedGeocoding.longitude
                                }
                            };
                        } else {
                            // Geocode and cache
                            const geocodingService = require('../services/geocoding.service');
                            const geocoded = await geocodingService.geocodeAddress(locationToGeocode);
                            finalUpdateData.coordinates = {
                                type: 'Point',
                                coordinates: {
                                    latitude: geocoded.latitude,
                                    longitude: geocoded.longitude
                                }
                            };

                            await cacheService.setGeocoding(locationToGeocode, geocoded);
                        }
                    }
                }

                // Update hospital profile
                updatedProfile = await Hospital.findOneAndUpdate(
                    { user: userId },
                    { ...finalUpdateData, updatedAt: new Date() },
                    {
                        new: true,
                        runValidators: true,
                        lean: true
                    }
                );

                // Update user name if changed
                if (updateData.hospitalLegalName && updateData.hospitalLegalName !== user.name) {
                    userUpdateData.name = updateData.hospitalLegalName;
                }
            }

            if (!updatedProfile) {
                throw new Error('Profile not found');
            }

            // Update user collection if needed
            if (userUpdateData.name) {
                await User.findByIdAndUpdate(
                    userId,
                    { name: userUpdateData.name },
                    { lean: true }
                );

                console.log(`Updated User name from "${user.name}" to "${userUpdateData.name}"`);

                // Re-populate the profile with updated user data
                await updatedProfile.populate('user', 'name email role isEmailVerified');
            }

            // Invalidate cache for this user
            await cacheService.invalidateUserProfiles(userId);

            // Invalidate profile status cache
            await cacheService.invalidateProfileStatus(userId);

            // Get fresh data for response
            const freshProfile = await this.getUserProfile(userId);

            return {
                success: true,
                profile: freshProfile.profile,
                message: 'Profile updated successfully'
            };
        } catch (error) {
            throw new Error(error.message);
        }
    }

    // Check if user has completed profile - OPTIMIZED VERSION
    async checkProfileCompletion(userId) {
        try {
            // Try cache first 
            const cachedStatus = await cacheService.getProfileStatus(userId);
            if (cachedStatus) {
                return {
                    ...cachedStatus,
                    fromCache: true,
                    cachedAt: new Date().toISOString()
                };
            }

            // Use lean query with only required fields
            const user = await User.findById(userId)
                .select('role isEmailVerified _id')  // Only select needed fields
                .lean();  // Convert to plain object for better performance

            if (!user) {
                throw new Error('User not found');
            }

            // Parallel profile check using aggregation
            let hasProfile = false;
            const profileCheckPromises = [];

            if (user.role === 'staff') {
                profileCheckPromises.push(
                    MedicalStaff.findOne({ user: userId })
                        .select('_id')  // Only check existence
                        .lean()
                        .then(profile => !!profile)
                );
            } else if (user.role === 'hospital') {
                profileCheckPromises.push(
                    Hospital.findOne({ user: userId })
                        .select('_id')  // Only check existence
                        .lean()
                        .then(profile => !!profile)
                );
            }

            // Execute profile checks in parallel
            if (profileCheckPromises.length > 0) {
                const results = await Promise.all(profileCheckPromises);
                hasProfile = results[0];
            }

            // Prepare result
            const result = {
                success: true,
                hasProfile,
                userRole: user.role,
                isEmailVerified: user.isEmailVerified,
                fromCache: false
            };

            // Cache the result for future requests
            await cacheService.setProfileStatus(userId, result);

            return result;
        } catch (error) {
            // Log error for monitoring
            console.error(`Profile completion check failed for user ${userId}:`, error.message);
            throw new Error(error.message);
        }
    }

    // Batch profile status check for admin dashboard - NEW METHOD
    async checkMultipleProfileCompletion(userIds) {
        try {
            // 1. Get cached statuses first
            const cachedResults = await cacheService.getMultipleProfileStatus(userIds);

            // 2. Identify uncached users
            const uncachedUserIds = cachedResults
                .filter(result => !result.data)
                .map(result => result.userId);

            if (uncachedUserIds.length === 0) {
                return cachedResults.map(result => ({
                    userId: result.userId,
                    ...result.data,
                    fromCache: true
                }));
            }

            // 3. Batch fetch uncached users
            const users = await User.find({
                _id: { $in: uncachedUserIds }
            })
                .select('role isEmailVerified _id')
                .lean();

            // 4. Batch fetch profiles
            const staffProfiles = await MedicalStaff.find({
                user: { $in: users.filter(u => u.role === 'staff').map(u => u._id) }
            })
                .select('user _id')
                .lean();

            const hospitalProfiles = await Hospital.find({
                user: { $in: users.filter(u => u.role === 'hospital').map(u => u._id) }
            })
                .select('user _id')
                .lean();

            // 5. Combine results
            const staffProfileUserIds = new Set(staffProfiles.map(p => p.user.toString()));
            const hospitalProfileUserIds = new Set(hospitalProfiles.map(p => p.user.toString()));

            const finalResults = userIds.map(userId => {
                const cached = cachedResults.find(r => r.userId === userId);
                if (cached && cached.data) {
                    return {
                        userId,
                        ...cached.data,
                        fromCache: true
                    };
                }

                const user = users.find(u => u._id.toString() === userId);
                if (!user) {
                    return {
                        userId,
                        success: false,
                        error: 'User not found'
                    };
                }

                const hasProfile = user.role === 'staff'
                    ? staffProfileUserIds.has(userId)
                    : user.role === 'hospital'
                        ? hospitalProfileUserIds.has(userId)
                        : false;

                const result = {
                    success: true,
                    hasProfile,
                    userRole: user.role,
                    isEmailVerified: user.isEmailVerified,
                    fromCache: false
                };

                // Cache individual results
                cacheService.setProfileStatus(userId, result);

                return result;
            });

            return finalResults;
        } catch (error) {
            throw new Error(error.message);
        }
    }

    // Toggle medical staff availability status
    async toggleMedicalStaffAvailability(userId, isAvailable) {
        try {
            // Input validation
            if (typeof isAvailable !== 'boolean') {
                throw new Error('isAvailable must be a boolean value');
            }

            // Parallel database queries for better performance
            const [user, medicalStaff] = await Promise.all([
                User.findById(userId).select('role _id').lean(),
                MedicalStaff.findOne({ user: userId }).select('_id').lean()
            ]);

            if (!user) {
                throw new Error('User not found');
            }

            if (user.role !== 'staff') {
                throw new Error('Only medical staff can toggle availability status');
            }

            if (!medicalStaff) {
                throw new Error('Medical staff profile not found');
            }

            // Optimized duty check with caching
            if (!isAvailable) {
                const cacheKey = `upcoming:duties:${userId}`;
                let upcomingDuties = await cacheService.get(cacheKey);

                if (!upcomingDuties) {
                    // Use lean query with minimal fields
                    const Duty = require('../models/Duty');
                    upcomingDuties = await Duty.find({
                        assignedTo: medicalStaff._id,
                        status: 'assigned',
                        date: { $gte: new Date() }
                    }).select('_id date startTime endTime').lean();

                    // Cache for 5 minutes
                    await cacheService.set(cacheKey, upcomingDuties, 300);
                }

                if (upcomingDuties.length > 0) {
                    throw new Error('Cannot set unavailable while you have upcoming duties');
                }
            }

            // Atomic update with lean options
            const updatedStaff = await MedicalStaff.findOneAndUpdate(
                { user: userId },
                {
                    isAvailable: isAvailable,
                    updatedAt: new Date()
                },
                {
                    new: true,
                    runValidators: true,
                    lean: true // Return plain object for better performance
                }
            );

            if (!updatedStaff) {
                throw new Error('Medical staff profile not found');
            }

            // Selective cache invalidation
            await Promise.all([
                cacheService.invalidateProfile(userId, 'staff'),
                cacheService.del(`upcoming:duties:${userId}`),
                // Invalidate nearby staff cache for hospitals
                cacheService.invalidatePattern('nearby:staff:*'),
                // Update availability cache
                cacheService.setStaffAvailability(userId, isAvailable, 60)
            ]);

            return {
                success: true,
                isAvailable: isAvailable,
                updatedAt: updatedStaff.updatedAt,
                message: `You are now ${isAvailable ? 'available' : 'unavailable'} for duties`
            };
        } catch (error) {
            throw new Error(error.message);
        }
    }



    // Get nearby available staff for hospital map dashboard
    async getNearbyAvailableStaff(hospitalUserId, radiusKm = 5) {
        try {
            // Get hospital profile
            const hospital = await Hospital.findOne({ user: hospitalUserId });
            if (!hospital) {
                throw new Error('Hospital profile not found');
            }

            // Validate radius 
            if (radiusKm < 5 || radiusKm > 100) {
                throw new Error('Radius must be between 5km and 100km');
            }

            const hospitalLat = hospital.coordinates.coordinates.latitude;
            const hospitalLng = hospital.coordinates.coordinates.longitude;

            console.log('Searching for staff within', radiusKm, 'km radius');

            // Use MongoDB's $geoWithin with bounding box first
            const latDelta = radiusKm / 111; // Approximate km to degrees
            const lngDelta = radiusKm / (111 * Math.cos(hospitalLat * Math.PI / 180));

            const nearbyStaff = await MedicalStaff.find({
                isAvailable: true,
                'coordinates.coordinates.latitude': {
                    $gte: hospitalLat - latDelta,
                    $lte: hospitalLat + latDelta
                },
                'coordinates.coordinates.longitude': {
                    $gte: hospitalLng - lngDelta,
                    $lte: hospitalLng + lngDelta
                }
            })
                .populate('user', 'name email role isEmailVerified')         // populate minimal user data fields only
                .select('fullName jobRole city area phoneNumber coordinates isAvailable averageRating')         // select only required fields
                .lean();    // return plain JavaScript objects instead of Mongoose documents

            console.log('Found', nearbyStaff.length, 'candidates via bounding box');

            // Filter by exact distance using Google Maps API only
            const exactNearbyStaff = [];
            for (const staff of nearbyStaff) {
                try {
                    const distanceResult = await geocodingService.calculateDistanceAndETA(
                        hospitalLat,
                        hospitalLng,
                        staff.coordinates.coordinates.latitude,
                        staff.coordinates.coordinates.longitude
                    );

                    staff.distance = parseFloat(distanceResult.distance.toFixed(2));
                    if (distanceResult.distance <= radiusKm) {
                        exactNearbyStaff.push(staff);
                    }
                } catch (error) {
                    console.error(`Google Maps API failed for staff ${staff._id}:`, error.message);
                    // Skip staff if Google Maps API fails
                    continue;
                }
            }

            // Format response
            const staffWithDistance = exactNearbyStaff.map(staff => ({
                ...staff,
                location: {
                    latitude: staff.coordinates.coordinates.latitude,
                    longitude: staff.coordinates.coordinates.longitude
                }
            }));

            // Sort by distance
            staffWithDistance.sort((a, b) => a.distance - b.distance);

            return {
                success: true,
                hospital: {
                    name: hospital.hospitalLegalName,
                    location: {
                        latitude: hospitalLat,
                        longitude: hospitalLng
                    }
                },
                searchRadius: radiusKm,
                totalStaffFound: staffWithDistance.length,
                staff: staffWithDistance,
                message: `Found ${staffWithDistance.length} available staff within ${radiusKm}km radius`
            };
        } catch (error) {
            console.error('Error in getNearbyAvailableStaff:', error);
            throw new Error(error.message);
        }
    }
    async uploadProfilePicture(userId, file) {
        try {
            // Validate file exists
            if (!file) {
                throw new Error("No file uploaded");
            }

            // Validate file type
            const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png'];
            if (!allowedMimeTypes.includes(file.mimetype)) {
                throw new Error('Invalid file type. Only JPG, JPEG, and PNG are allowed');
            }

            // Validate file size (5MB)
            if (file.size > 5 * 1024 * 1024) {
                throw new Error('File too large. Maximum size is 5MB');
            }

            const user = await User.findById(userId).lean();
            if (!user) throw new Error("User not found");

            let model;

            // Fix: Use correct role names
            if (user.role === 'staff') {
                model = MedicalStaff;
            } else if (user.role === 'hospital') {
                model = Hospital;
            } else {
                throw new Error("Invalid user role");
            }

            const profile = await model.findOne({ user: userId });
            if (!profile) throw new Error("Profile not found");

            // Delete old image if exists
            if (profile.profilePicture?.s3Key) {
                try {
                    await deleteFromS3(profile.profilePicture.s3Key);
                } catch (deleteError) {
                    // Log but don't fail - old file might already be deleted
                    console.error('Failed to delete old profile picture:', deleteError.message);
                }
            }

            // Get name based on role
            let fileName = '';

            if (user.role === 'staff') {
                fileName = profile.fullName;
            } else if (user.role === 'hospital') {
                fileName = profile.hospitalLegalName;
            }

            // Fallback if name missing
            if (!fileName) {
                fileName = userId;
            }

            // Clean name 
            fileName = fileName
                .toLowerCase()
                .replace(/\s+/g, '-')
                .replace(/[^a-z0-9\-]/g, '');

            // Extension
            const ext = path.extname(file.originalname);

            // Final key
            const key = `profile-pictures/${user.role}/${fileName}-${Date.now()}${ext}`;

            let uploadSuccess = false;

            try {
                // Upload to S3
                await uploadToS3(file.buffer, key, file.mimetype);
                uploadSuccess = true;

                // Save metadata in DB
                await model.findOneAndUpdate(
                    { user: userId },
                    {
                        profilePicture: {
                            s3Key: key,
                            uploadedAt: new Date(),
                            fileSize: file.size,
                            mimeType: file.mimetype
                        }
                    },
                    { new: true }
                );

                // Generate presigned URL
                const url = await generatePreSignedURL(key);

                // Clear cache
                await cacheService.invalidateProfile(userId, user.role);

                return {
                    success: true,
                    profilePicture: url,
                    message: "Profile picture uploaded successfully"
                };

            } catch (error) {
                // Rollback: delete from S3 if DB update failed
                if (uploadSuccess) {
                    try {
                        await deleteFromS3(key);
                    } catch (cleanupError) {
                        console.error('Failed to cleanup S3 after error:', cleanupError.message);
                    }
                }
                throw error;
            }

        } catch (error) {
            throw new Error(error.message);
        }
    }

    async deleteProfilePicture(userId) {
        try {
            const user = await User.findById(userId).lean();
            if (!user) throw new Error("User not found");

            let model;

            // Fix: Use correct role names
            if (user.role === 'staff') {
                model = MedicalStaff;
            } else if (user.role === 'hospital') {
                model = Hospital;
            } else {
                throw new Error("Invalid user role");
            }

            const profile = await model.findOne({ user: userId });
            if (!profile) throw new Error("Profile not found");

            if (!profile.profilePicture?.s3Key) {
                throw new Error("No profile picture found");
            }

            // Delete from S3
            try {
                await deleteFromS3(profile.profilePicture.s3Key);
            } catch (deleteError) {
                console.error('Failed to delete from S3:', deleteError.message);
                // Continue to remove from DB even if S3 delete fails
            }

            // Remove from DB
            await model.findOneAndUpdate(
                { user: userId },
                { profilePicture: null },
                { new: true }
            );

            // Clear cache
            await cacheService.invalidateProfile(userId, user.role);

            return {
                success: true,
                message: "Profile picture deleted successfully"
            };

        } catch (error) {
            throw new Error(error.message);
        }
    }
    // Add skills (append unique)
    async addSkills(userId, skills = []) {
        if (!Array.isArray(skills) || skills.length === 0) {
            throw new Error('Skills must be a non-empty array');
        }

        const cleanedSkills = skills.map(s => s.trim()).filter(Boolean);

        const updated = await MedicalStaff.findOneAndUpdate(
            { user: userId },
            {
                $addToSet: { skills: { $each: cleanedSkills } }, // ✅ no duplicates
                $set: { updatedAt: new Date() }
            },
            {
                new: true
            }
        );

        if (!updated) throw new Error('Medical staff profile not found');

        await cacheService.invalidateProfile(userId, 'staff');

        return {
            success: true,
            skills: updated.skills,
            message: 'Skills added successfully'
        };
    }


    // Get skills
    async getSkills(userId) {
        const staff = await MedicalStaff.findOne({ user: userId })
            .select('skills')
            .lean();

        if (!staff) throw new Error('Medical staff profile not found');

        return {
            success: true,
            skills: staff.skills || []
        };
    }


    // Update skills
    async updateSkills(userId, skills = []) {
        if (!Array.isArray(skills)) {
            throw new Error('Skills must be an array');
        }

        const cleanedSkills = skills.map(s => s.trim()).filter(Boolean);

        const updated = await MedicalStaff.findOneAndUpdate(
            { user: userId },
            {
                $set: {
                    skills: cleanedSkills,
                    updatedAt: new Date()
                }
            },
            { new: true }
        );

        if (!updated) throw new Error('Medical staff profile not found');

        await cacheService.invalidateProfile(userId, 'staff');

        return {
            success: true,
            skills: updated.skills,
            message: 'Skills updated successfully'
        };
    }

}

module.exports = new ProfileService();
