const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const Duty = require('../models/Duty');
const cacheService = require('./cache.service');
const { NotFoundError, ValidationError } = require('../middleware/error.middleware');

const MAX_BLOCKED = 500;
const UPCOMING = ['assigned', 'enroute', 'in-progress'];

// Blocks between a doctor and a hospital. Either side blocking hides the two
// from each other: duty offers and pushes, the duty feed and calendar, duty
// detail and accept, invites and the hospital's staff map. Duties already
// accepted between them are left as they are.
class BlockService {
    // Hospital ids hidden from this doctor, in either direction
    async hospitalsHiddenFrom(medicalStaffId) {
        const [staff, blockedBy] = await Promise.all([
            MedicalStaff.findById(medicalStaffId).select('blockedHospitals').lean(),
            Hospital.find({ blockedStaff: medicalStaffId }).distinct('_id')
        ]);
        return [...new Set([...(staff?.blockedHospitals || []), ...blockedBy].map(String))];
    }

    // Doctor ids hidden from this hospital, in either direction
    async staffHiddenFrom(hospitalId) {
        const [hospital, blockedBy] = await Promise.all([
            Hospital.findById(hospitalId).select('blockedStaff').lean(),
            MedicalStaff.find({ blockedHospitals: hospitalId }).distinct('_id')
        ]);
        return [...new Set([...(hospital?.blockedStaff || []), ...blockedBy].map(String))];
    }

    async isBlocked(hospitalId, medicalStaffId) {
        const [byHospital, byStaff] = await Promise.all([
            Hospital.exists({ _id: hospitalId, blockedStaff: medicalStaffId }),
            MedicalStaff.exists({ _id: medicalStaffId, blockedHospitals: hospitalId })
        ]);
        return Boolean(byHospital || byStaff);
    }

    // --- Doctor side ---

    async listForStaff(staffUserId) {
        const staff = await this._staffFor(staffUserId, 'blockedHospitals');
        const hospitals = await Hospital.find({ _id: { $in: staff.blockedHospitals || [] } })
            .select('hospitalLegalName city').lean();
        return hospitals.map(h => ({ hospitalId: h._id, name: h.hospitalLegalName, city: h.city || null }));
    }

    async blockHospital(staffUserId, hospitalId) {
        const staff = await this._staffFor(staffUserId, '_id blockedHospitals');
        const hospital = await Hospital.findById(hospitalId).select('_id user hospitalLegalName').lean();
        if (!hospital) throw new NotFoundError('Hospital not found');
        this._assertRoom(staff.blockedHospitals, hospitalId);

        await Promise.all([
            MedicalStaff.updateOne({ _id: staff._id }, { $addToSet: { blockedHospitals: hospital._id } }),
            Hospital.updateOne({ _id: hospital._id }, { $pull: { favouriteStaff: staff._id } })
        ]);
        await this._clearMapCache(hospital.user);
        return { blocked: { id: hospital._id, name: hospital.hospitalLegalName }, upcomingDuties: await this._upcoming(hospital._id, staff._id) };
    }

    async unblockHospital(staffUserId, hospitalId) {
        const staff = await this._staffFor(staffUserId, '_id');
        await MedicalStaff.updateOne({ _id: staff._id }, { $pull: { blockedHospitals: hospitalId } });
        const hospital = await Hospital.findById(hospitalId).select('user').lean();
        if (hospital) await this._clearMapCache(hospital.user);
    }

    // --- Hospital side ---

    async listForHospital(hospitalUserId) {
        const hospital = await this._hospitalFor(hospitalUserId, 'blockedStaff');
        const staff = await MedicalStaff.find({ _id: { $in: hospital.blockedStaff || [] } })
            .select('fullName jobRole city').lean();
        return staff.map(s => ({ staffId: s._id, name: s.fullName, jobRole: s.jobRole, city: s.city || null }));
    }

    async blockStaff(hospitalUserId, staffId) {
        const hospital = await this._hospitalFor(hospitalUserId, '_id blockedStaff');
        const staff = await MedicalStaff.findById(staffId).select('_id fullName').lean();
        if (!staff) throw new NotFoundError('Doctor not found');
        this._assertRoom(hospital.blockedStaff, staffId);

        await Hospital.updateOne(
            { _id: hospital._id },
            { $addToSet: { blockedStaff: staff._id }, $pull: { favouriteStaff: staff._id } }
        );
        await this._clearMapCache(hospitalUserId);
        return { blocked: { id: staff._id, name: staff.fullName }, upcomingDuties: await this._upcoming(hospital._id, staff._id) };
    }

    async unblockStaff(hospitalUserId, staffId) {
        const hospital = await this._hospitalFor(hospitalUserId, '_id');
        await Hospital.updateOne({ _id: hospital._id }, { $pull: { blockedStaff: staffId } });
        await this._clearMapCache(hospitalUserId);
    }

    // --- Helpers ---

    _assertRoom(list, id) {
        const ids = (list || []).map(String);
        if (!ids.includes(String(id)) && ids.length >= MAX_BLOCKED) {
            throw new ValidationError(`You can block up to ${MAX_BLOCKED} accounts`);
        }
    }

    // Accepted duties between the two that the block doesn't cancel
    async _upcoming(hospitalId, staffId) {
        return Duty.countDocuments({ hospital: hospitalId, assignedTo: staffId, status: { $in: UPCOMING } });
    }

    async _clearMapCache(hospitalUserId) {
        if (hospitalUserId) await cacheService.invalidatePattern(`nearby:staff:${hospitalUserId}:*`);
    }

    async _staffFor(userId, select) {
        const staff = await MedicalStaff.findOne({ user: userId }).select(select).lean();
        if (!staff) throw new NotFoundError('Medical staff profile not found');
        return staff;
    }

    async _hospitalFor(userId, select) {
        const hospital = await Hospital.findOne({ user: userId }).select(select).lean();
        if (!hospital) throw new NotFoundError('Hospital profile not found');
        return hospital;
    }
}

module.exports = new BlockService();
