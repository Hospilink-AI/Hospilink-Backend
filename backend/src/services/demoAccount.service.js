const User = require('../models/User');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const Duty = require('../models/Duty');
const cacheService = require('./cache.service');
const staffLocator = require('./staffLocator.service');
const { NotFoundError, ValidationError } = require('../middleware/error.middleware');

// Demo accounts for the Google Play and App Store review teams. A demo
// doctor and a demo hospital only ever see and reach each other: their
// duties, offers, invites, maps and favourites never touch real accounts,
// they are left out of analytics, and a demo doctor is placed at their
// profile address (reviewers test from abroad).
class DemoAccountService {
    async list() {
        const [hospitals, staff] = await Promise.all([
            Hospital.find({ isDemo: true }).select('user hospitalLegalName city verificationStatus').populate('user', 'email').lean(),
            MedicalStaff.find({ isDemo: true }).select('user fullName jobRole city verificationStatus').populate('user', 'email').lean()
        ]);
        return [
            ...hospitals.map(h => ({ userId: h.user?._id, role: 'hospital', name: h.hospitalLegalName, email: h.user?.email, city: h.city, verificationStatus: h.verificationStatus })),
            ...staff.map(s => ({ userId: s.user?._id, role: 'staff', name: s.fullName, jobRole: s.jobRole, email: s.user?.email, city: s.city, verificationStatus: s.verificationStatus }))
        ];
    }

    // Marking skips email, document and admin verification, so reviewers can
    // sign in with just the email and password. Unmarking sends the account
    // back to pending verification.
    async set(userId, isDemo) {
        if (typeof isDemo !== 'boolean') throw new ValidationError('isDemo must be true or false');
        const user = await User.findById(userId).select('role email deletion').lean();
        if (!user || !['staff', 'hospital'].includes(user.role)) {
            throw new NotFoundError('Doctor or hospital account not found');
        }
        if (user.deletion?.requestedAt) throw new ValidationError('This account is being deleted');

        const isHospital = user.role === 'hospital';
        const Profile = isHospital ? Hospital : MedicalStaff;
        const profile = await Profile.findOne({ user: userId }).select('_id').lean();
        if (!profile) throw new ValidationError('The account must create its profile in the app first');

        if (isDemo) {
            await Promise.all([
                User.updateOne({ _id: userId }, { $set: { isEmailVerified: true } }),
                Profile.updateOne({ _id: profile._id }, {
                    $set: { isDemo: true, verificationStatus: 'verified', verifiedAt: new Date(), isDocumentsUploaded: true }
                })
            ]);
        } else {
            await Profile.updateOne({ _id: profile._id }, {
                $unset: { isDemo: 1, verifiedAt: 1 },
                $set: { verificationStatus: 'pending' }
            });
        }

        if (isHospital) {
            await Duty.updateMany({ hospital: profile._id }, isDemo ? { $set: { isDemo: true } } : { $unset: { isDemo: 1 } });
        } else {
            // Any live position they had would otherwise place them abroad
            const client = await require('../config/redis').getClientAsync();
            await Promise.all([client.del(`dashboard:location:${userId}`), staffLocator.removeLivePosition(userId)]);
        }

        await Promise.all([
            cacheService.del(`demo:staff:${userId}`),
            cacheService.del(`session:${userId}`),
            cacheService.del(`user:${user.email}`),
            cacheService.del(`${isHospital ? 'hospital' : 'staff'}_verification:${userId}`),
            cacheService.invalidateUserProfiles(userId),
            cacheService.invalidateProfileStatus(userId)
        ]);

        return { userId, role: user.role, isDemo };
    }
}

module.exports = new DemoAccountService();
