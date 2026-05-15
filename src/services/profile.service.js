const MedicalStaff = require('../models/MedicalStaff');
const Hospital = require('../models/Hospital');
const User = require('../models/User');
const Duty = require('../models/Duty');
const Document = require('../models/Document');
const geocodingService = require('../services/geocoding.service');
const cacheService = require('./cache.service');
// const { toRadians } = require('../utils/helpers');
const documentService = require('./document.service');
const Review = require('../models/Review');
const path = require('path');
const { uploadToS3, deleteFromS3, generatePreSignedURL } = require('./s3.service');
const notificationEmitter = require('./notificationEmitter');
const emailService = require('./email.service');
const requiredDocsConfig = require('../config/requiredDocs');
const { getBatchStaffDutyStatus } = require('../utils/dutyStatus.helper');            


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

            // Email must match signup email
            if (profileData.email && profileData.email !== user.email) {
                throw new Error('Email must match the email used during signup');
            }

            // Full name must match signup name
            if (profileData.fullName && profileData.fullName.trim() !== user.name.trim()) {
                throw new Error(`Full name "${profileData.fullName}" must match the name used during signup "${user.name}"`);
            }

            // Use signup email for profile
            profileData.email = user.email;

            // Check if profile already exists
            const existingProfile = await MedicalStaff.findOne({ user: userId });
            if (existingProfile) {
                throw new Error('Medical staff profile already exists');
            }

            let coordinates = null;

            // Always geocode from address - no location permission during profile creation
            const address = `${profileData.currentAddress}, ${profileData.city}, ${profileData.state}, ${profileData.pincode}`;
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
                currentAddress: profileData.currentAddress,
                city: profileData.city,
                state: profileData.state,
                pincode: profileData.pincode,
                phoneNumber: profileData.phoneNumber,
                email: profileData.email,
                coordinates: coordinates,
                profileSummary: profileData.profileSummary || '',
                education: profileData.education || [],
                skills: profileData.skills || [],
                experience: profileData.experience,
                isAvailable: false
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
                const user = await User.findById(userId);
                await notificationEmitter.emitNewStaffRegistration(medicalStaffProfile, user);
            } catch (notifError) {
                console.error('Error sending staff registration notification:', notifError);
                // Don't fail the registration if notification fails
            }

            // Send profile creation confirmation email
            try {
                await emailService.sendProfileCreatedConfirmationEmail(
                    user.email,
                    medicalStaffProfile.fullName || user.name,
                    'staff'
                );
            } catch (emailError) {
                console.error('Error sending profile creation email:', emailError);
                // Don't fail the registration if email fails
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

            // Email must match signup email
            if (profileData.email && profileData.email !== user.email) {
                throw new Error('Email must match the email used during signup');
            }

            // Hospital name must match signup name
            if (profileData.hospitalLegalName && profileData.hospitalLegalName.trim() !== user.name.trim()) {
                throw new Error(`Hospital name "${profileData.hospitalLegalName}" must match the name used during signup "${user.name}"`);
            }

            // Use signup email for profile
            profileData.email = user.email;

            // Check if profile already exists
            const existingProfile = await Hospital.findOne({ user: userId });
            if (existingProfile) {
                throw new Error('Hospital profile already exists');
            }

            let coordinates;
            let geocodingAddress;
            let geocodingSource = 'google_maps_api';

            // Build comprehensive address for geocoding using new fields
            const addressParts = [
                profileData.hospitalLegalName,
                profileData.currentAddress,
                profileData.city,
                profileData.state,
                profileData.pincode
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

                // Try with simplified address (hospital name + city + state)
                try {
                    const simplifiedAddress = `${profileData.hospitalLegalName}, ${profileData.city}, ${profileData.state}`;
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
                        const fallbackAddress = `${profileData.hospitalLegalName}, ${profileData.city || 'India'}, ${profileData.state || 'India'}`;
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
                email: profileData.email, 
                currentAddress: profileData.currentAddress,
                city: profileData.city,
                state: profileData.state,
                pincode: profileData.pincode,
                phoneNumber: profileData.phoneNumber,
                servicesAvailable: profileData.servicesAvailable,
                staffCount: profileData.staffCount,
                description: profileData.description || '',
                coordinates: coordinates
            });

            await hospitalProfile.save();

            // Populate user data
            await hospitalProfile.populate('user', 'name email role isEmailVerified');

            await cacheService.setProfile(userId, 'hospital', hospitalProfile.toObject());

            // Invalidate profile status cache
            await cacheService.invalidateProfileStatus(userId);

            // Emit notification to admins about new hospital registration
            try {
                const user = await User.findById(userId);
                await notificationEmitter.emitNewHospitalRegistration(hospitalProfile, user);
            } catch (notifError) {
                console.error('Error sending hospital registration notification:', notifError);
                // Don't fail the registration if notification fails
            }

            // Send profile creation confirmation email
            try {
                await emailService.sendProfileCreatedConfirmationEmail(
                    user.email,
                    hospitalProfile.hospitalLegalName || user.name,
                    'hospital'
                );
            } catch (emailError) {
                console.error('Error sending profile creation email:', emailError);
                // Don't fail the registration if email fails
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
            const user = await User.findById(userId).select('name email role isEmailVerified isDocumentsUploaded').lean();
            if (!user) throw new Error('User not found');

            // Check cache first
            const cachedProfile = await cacheService.getProfile(userId, user.role);
            if (cachedProfile) return cachedProfile;

            // Use aggregation for single query
            let profile = null;

            if (user.role === 'staff') {
                const raw = await MedicalStaff.findOne({ user: userId }).lean();
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
                        raw.fullName, raw.jobRole, raw.currentAddress, raw.city,
                        raw.state, raw.pincode, raw.phoneNumber, raw.profileSummary,
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
                        currentAddress: raw.currentAddress,
                        city: raw.city,
                        state: raw.state,
                        pincode: raw.pincode,
                        phoneNumber: raw.phoneNumber,
                        email: user.email, // Get from user collection
                        profileSummary: raw.profileSummary || '',
                        education: raw.education || [],
                        skills: raw.skills || [],
                        experience: raw.experience,
                        isAvailable: raw.isAvailable,
                        isProfileComplete: raw.isProfileComplete,
                        isDocumentsUploaded: raw.isDocumentsUploaded ?? false,
                        verificationStatus: raw.verificationStatus,
                        profileCompletion,
                        activeApplications,
                        verifiedDocs,
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
                        email: user.email, // Get from user collection (already fetched above)
                        profilePicture: profilePictureUrl,
                        currentAddress: raw.currentAddress,
                        city: raw.city,
                        state: raw.state,
                        pincode: raw.pincode,
                        phoneNumber: raw.phoneNumber,
                        servicesAvailable: raw.servicesAvailable,
                        isProfileComplete: raw.isProfileComplete,
                        isDocumentsUploaded: raw.isDocumentsUploaded ?? false,
                        verificationStatus: raw.verificationStatus,
                        staffCount: raw.staffCount,
                        description: raw.description || '',
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
                    isEmailVerified: user.isEmailVerified,
                    isDocumentsUploaded: user.isDocumentsUploaded
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

                // Prevent email changes (read-only after creation)
                if (updateData.email && updateData.email !== user.email) {
                    throw new Error('Email cannot be changed after profile creation');
                }

                // Prevent phone number changes (read-only after creation)
                if (updateData.phoneNumber && updateData.phoneNumber !== currentProfile.phoneNumber) {
                    throw new Error('Phone number cannot be changed after profile creation');
                }

                // Remove read-only fields from update data
                delete updateData.email;
                delete updateData.phoneNumber;

                let finalUpdateData = { ...updateData };

                // Check if location fields changed
                const cityChanged = updateData.city && updateData.city !== currentProfile.city;
                const areaChanged = updateData.area && updateData.area !== currentProfile.area;
                const currentAddressChanged = updateData.currentAddress && updateData.currentAddress !== currentProfile.currentAddress;
                const stateChanged = updateData.state && updateData.state !== currentProfile.state;
                const pincodeChanged = updateData.pincode && updateData.pincode !== currentProfile.pincode;

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

                if (updateData.experience !== undefined) {
                    finalUpdateData.experience = updateData.experience;
                }

                // Only geocode if location fields actually changed
                if (cityChanged || currentAddressChanged || stateChanged || pincodeChanged) {
                    if (!updateData.coordinates || !updateData.coordinates.latitude || !updateData.coordinates.longitude) {
                        const address = `${updateData.currentAddress || currentProfile.currentAddress}, ${updateData.city || currentProfile.city}, ${updateData.state || currentProfile.state}, ${updateData.pincode || currentProfile.pincode}`;

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

                // Prevent email changes (read-only after creation)
                if (updateData.email && updateData.email !== user.email) {
                    throw new Error('Email cannot be changed after profile creation');
                }

                // Prevent phone number changes (read-only after creation)
                if (updateData.phoneNumber && updateData.phoneNumber !== currentProfile.phoneNumber) {
                    throw new Error('Phone number cannot be changed after profile creation');
                }

                // Remove read-only fields from update data
                delete finalUpdateData.email;
                delete finalUpdateData.phoneNumber;

                // Handle location changes with caching
                const cityChanged = updateData.city && updateData.city !== currentProfile.city;
                const stateChanged = updateData.state && updateData.state !== currentProfile.state;
                const pincodeChanged = updateData.pincode && updateData.pincode !== currentProfile.pincode;

                if (cityChanged || stateChanged || pincodeChanged) {
                    const addressParts = [
                        updateData.hospitalLegalName || currentProfile.hospitalLegalName,
                        updateData.currentAddress || currentProfile.currentAddress,
                        updateData.city || currentProfile.city,
                        updateData.state || currentProfile.state,
                        updateData.pincode || currentProfile.pincode
                    ].filter(part => part && part.trim() !== '');
                    
                    const locationToGeocode = addressParts.join(', ');

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

                // Skip phone number update (read-only after creation)
                // Remove email from update data (read-only)
                delete finalUpdateData.phoneNumber;
                delete finalUpdateData.email;

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

            // Ensure email and phone are always included in response
            if (freshProfile.profile) {
                if (user.role === 'hospital') {
                    // Email comes from user collection (always available)
                    freshProfile.profile.email = user.email;
                    
                    // Phone comes from hospital profile (read-only)
                    const hospitalProfile = await Hospital.findOne({ user: userId }).lean();
                    if (hospitalProfile) {
                        freshProfile.profile.phoneNumber = hospitalProfile.phoneNumber;
                    }
                } else if (user.role === 'staff') {
                    // Email comes from user collection (always available)
                    freshProfile.profile.email = user.email;
                    
                    // Phone comes from staff profile (read-only)
                    const staffProfile = await MedicalStaff.findOne({ user: userId }).lean();
                    if (staffProfile) {
                        freshProfile.profile.phoneNumber = staffProfile.phoneNumber;
                    }
                }
            }

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

            const user = await User.findById(userId)
                .select('role isEmailVerified _id')
                .lean();

            if (!user) throw new Error('User not found');


            // Run profile + document checks in parallel
            let profileDoc = null;
            const [profileResult, docRecord] = await Promise.all([
                user.role === 'staff'
                    ? MedicalStaff.findOne({ user: userId }).select('_id isDocumentsUploaded').lean()
                    : user.role === 'hospital'
                        ? Hospital.findOne({ user: userId }).select('_id isDocumentsUploaded').lean()
                        : Promise.resolve(null),
                Document.findOne({ userId }).select('documents').lean()
            ]);

            const hasProfile = !!profileResult;

            // Check document completeness against required docs config
            let documentsStatus = { uploaded: [], missing: [], hasAllRequired: false };

            if (hasProfile && user.role !== 'admin') {
                const roleConfig = requiredDocsConfig[user.role];
                const uploadedTypes = (docRecord?.documents || [])
                    .filter(d => !d.isDeleted)
                    .map(d => d.documentType);

                const missingRequired = (roleConfig?.required || [])
                    .filter(type => !uploadedTypes.includes(type));

                const missingConditional = (roleConfig?.conditional || [])
                    .filter(group => !group.some(type => uploadedTypes.includes(type)))
                    .map(group => group);

                // Use the cached flag for the boolean, dynamic check for details
                const hasAllRequired = profileResult.isDocumentsUploaded === true;

                documentsStatus = {
                    uploaded: uploadedTypes,
                    missingRequired,
                    missingConditional,
                    hasAllRequired
                };
            }

            // Derive onboarding step for frontend routing:
            // 'verify_email'  → email not verified
            // 'create_profile' → email verified but no profile
            // 'upload_documents' → profile exists but required docs missing
            // 'complete' → everything done
            let onboardingStep = 'complete';
            if (!user.isEmailVerified) {
                onboardingStep = 'verify_email';
            } else if (!hasProfile) {
                onboardingStep = 'create_profile';
            } else if (!documentsStatus.hasAllRequired) {
                onboardingStep = 'upload_documents';
            }

            const result = {
                success: true,
                onboardingStep,
                isEmailVerified: user.isEmailVerified,
                hasProfile,
                documents: documentsStatus,
                userRole: user.role,
                fromCache: false
            };

            await cacheService.setProfileStatus(userId, result);
            return result;
        } catch (error) {
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
                MedicalStaff.findOne({ user: userId }).select('verificationStatus isAvailable _id').lean()
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

            // Check verification status for availability toggle
            if (medicalStaff.verificationStatus === 'pending') {
                const availabilityMessage = isAvailable 
                    ? 'You cannot set availability to ON until your profile has been verified.'
                    : 'You won\'t receive duty requests unless your profile has been verified.';
                
                return {
                    success: false,
                    message: availabilityMessage,
                    verificationStatus: medicalStaff.verificationStatus,
                    canToggleAvailability: false
                };
            }

            if (medicalStaff.verificationStatus === 'rejected') {
                return {
                    success: false,
                    message: `Your profile has been rejected. Reason: ${medicalStaff.rejectionReason || 'Not specified'}. Please contact support for assistance.`,
                    verificationStatus: medicalStaff.verificationStatus,
                    canToggleAvailability: false
                };
            }

            // Auto-enable availability when verified and setting to ON
            let finalAvailability = isAvailable;
            if (isAvailable && medicalStaff.verificationStatus === 'verified') {
                finalAvailability = true;
            }

            // Optimized duty check with caching
            if (!finalAvailability) {
                const cacheKey = `upcoming:duties:${userId}`;
                let upcomingDuties = await cacheService.get(cacheKey);

                if (!upcomingDuties) {
                    // Use lean query with minimal fields
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
                    isAvailable: finalAvailability,
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
                cacheService.setStaffAvailability(userId, finalAvailability, 60),
                // Invalidate verification cache to refresh availability status
                cacheService.del(`staff_verification:${userId}`)
            ]);

            // Return appropriate response based on verification status
            const successMessage = medicalStaff.verificationStatus === 'verified' && finalAvailability
                ? 'Ready to receive new duties'
                : 'Availability status updated successfully';

            return {
                success: true,
                isAvailable: finalAvailability,
                updatedAt: updatedStaff.updatedAt,
                message: successMessage,
                verificationStatus: medicalStaff.verificationStatus,
                canToggleAvailability: medicalStaff.verificationStatus === 'verified'
            };
        } catch (error) {
            throw new Error(error.message);
        }
    }



    // Get nearby available staff for hospital map dashboard
    async getNearbyAvailableStaff(hospitalUserId, radiusKm = 5, role = null) {
        try {
            // Input validation
            if (radiusKm < 1 || radiusKm > 100) {
                throw new Error('Radius must be between 1km and 100km');
            }

            // Check cache first (2 minutes for location-based queries)
            const cacheKey = `nearby:staff:${hospitalUserId}:${radiusKm}:${role || 'all'}`;
            const cached = await cacheService.get(cacheKey);
            if (cached) {
                return {
                    ...cached,
                    cached: true,
                    timestamp: new Date().toISOString()
                };
            }

            // Get hospital profile with minimal fields
            const hospital = await Hospital.findOne({ user: hospitalUserId })
                .select('_id hospitalLegalName coordinates currentAddress city state pincode')
                .lean();

            if (!hospital) {
                throw new Error('Hospital profile not found');
            }

            if (!hospital.coordinates || !hospital.coordinates.coordinates) {
                throw new Error('Hospital location coordinates not found');
            }

            const hospitalLat = hospital.coordinates.coordinates.latitude;
            const hospitalLng = hospital.coordinates.coordinates.longitude;

            console.log(`Searching for staff within ${radiusKm}km radius`);

            // Optimized bounding box query with compound index
            const latDelta = radiusKm / 111;
            const lngDelta = radiusKm / (111 * Math.cos(hospitalLat * Math.PI / 180));

            const query = {
                isAvailable: true,
                verificationStatus: 'verified', // Only verified staff
                'coordinates.coordinates.latitude': {
                    $gte: hospitalLat - latDelta,
                    $lte: hospitalLat + latDelta
                },
                'coordinates.coordinates.longitude': {
                    $gte: hospitalLng - lngDelta,
                    $lte: hospitalLng + lngDelta
                }
            };

            if (role) {
                query.jobRole = role;
            }

            // Optimized query without pagination
            const nearbyStaff = await MedicalStaff.find(query)
                .populate('user', 'name email')
                .select('fullName jobRole currentAddress city state pincode phoneNumber coordinates isAvailable averageRating verificationStatus') 
                .sort({ 'coordinates.coordinates.latitude': 1, 'coordinates.coordinates.longitude': 1 })
                .lean();

            console.log(`Found ${nearbyStaff.length} candidates via bounding box`);

            // Batch Google Maps API calls (optimized for performance)
            const staffWithDistance = await Promise.allSettled(
                nearbyStaff.map(async (staff) => {
                    try {
                        const distanceResult = await geocodingService.calculateDistanceAndETA(
                            hospitalLat,
                            hospitalLng,
                            staff.coordinates.coordinates.latitude,
                            staff.coordinates.coordinates.longitude
                        );

                        return {
                            ...staff,
                            distance: parseFloat(distanceResult.distance.toFixed(2)),
                            distanceText: distanceResult.distanceText,
                            estimatedTime: distanceResult.duration,
                            estimatedTimeText: distanceResult.durationText
                        };
                    } catch (error) {
                        console.error(`Google Maps API failed for staff ${staff._id}:`, error.message);
                        return null;
                    }
                })
            );

            // Filter successful results and apply exact distance filter
            const validStaff = staffWithDistance
                .filter(result => result.status === 'fulfilled' && result.value && result.value.distance <= radiusKm)
                .map(result => result.value);

            console.log(`Found ${validStaff.length} staff within exact distance`);

            // Get duty status for all valid staff (batch optimized)
            const staffIds = validStaff.map(staff => staff._id);
            const dutyStatusMap = await getBatchStaffDutyStatus(staffIds);

            // Format response with duty status
            const staffWithDutyStatus = validStaff.map(staff => {
                const dutyStatus = dutyStatusMap.get(staff._id.toString());
                
                return {
                    id: staff._id,
                    name: staff.fullName,
                    email: staff.user?.email || staff.email,
                    role: staff.jobRole,
                    phone: staff.phoneNumber,
                    rating: staff.averageRating || 0,
                    isAvailable: staff.isAvailable,
                    verificationStatus: staff.verificationStatus, 
                    distance: staff.distance,
                    distanceText: staff.distanceText,
                    estimatedTime: staff.estimatedTime,
                    estimatedTimeText: staff.estimatedTimeText,
                    availabilityStatus: dutyStatus.status,
                    hasActiveDuty: dutyStatus.hasActiveDuty,
                    hasUpcomingDuty: dutyStatus.hasUpcomingDuty,
                    currentDuty: dutyStatus.currentDuty,
                    nextDuty: dutyStatus.nextDuty,
                    activeDutyCount: dutyStatus.activeDutyCount,
                    upcomingDutyCount: dutyStatus.upcomingDutyCount,
                    address: {
                        currentAddress: staff.currentAddress,
                        city: staff.city,
                        state: staff.state,
                        pincode: staff.pincode
                    },
                    location: {
                        latitude: staff.coordinates.coordinates.latitude,
                        longitude: staff.coordinates.coordinates.longitude
                    }
                };
            });

            // Sort by distance
            staffWithDutyStatus.sort((a, b) => a.distance - b.distance);

            const result = {
                success: true,
                cached: false,
                data: {
                    hospital: {
                        id: hospital._id,
                        name: hospital.hospitalLegalName,
                        address: {
                            currentAddress: hospital.currentAddress,
                            city: hospital.city,
                            state: hospital.state,
                            pincode: hospital.pincode
                        },
                        location: {
                            latitude: hospitalLat,
                            longitude: hospitalLng
                        }
                    },
                    search: {
                        radius: radiusKm,
                        roleFilter: role || 'all',
                        totalFound: staffWithDutyStatus.length
                    },
                    staff: staffWithDutyStatus,
                    summary: {
                        totalStaff: staffWithDutyStatus.length,
                        fullyAvailable: staffWithDutyStatus.filter(s => s.availabilityStatus === 'fully_available').length,
                        hasUpcomingDuties: staffWithDutyStatus.filter(s => s.availabilityStatus === 'has_upcoming_duties').length,
                        hasActiveDuties: staffWithDutyStatus.filter(s => s.availabilityStatus === 'has_active_duties').length
                    }
                },
                message: `Found ${staffWithDutyStatus.length} available staff within ${radiusKm}km radius${role ? ` for role: ${role}` : ''}`,
                timestamp: new Date().toISOString()
            };

            // Cache result for 2 minutes
            await cacheService.set(cacheKey, result, 120);
            return result;
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
