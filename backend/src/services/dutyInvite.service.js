const mongoose = require('mongoose');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const Duty = require('../models/Duty');
const staffLocator = require('./staffLocator.service');
const blockService = require('./block.service');
const ratingAlgorithmService = require('./ratingAlgorithm.service');
const s3Service = require('./s3.service');
const systemConfigService = require('./systemConfig.service');
const logger = require('../utils/logger');
const StaffAvailability = require('../models/StaffAvailability');
const { normalizeRole, doDutiesOverlap } = require('../utils/helpers');
const { resolveDay, isFreeFor } = require('../utils/availability.helper');
const { NotFoundError, ValidationError } = require('../middleware/error.middleware');

const MAX_FAVOURITES = 200;
const MAX_INVITEES = 20;
const CANDIDATES_PER_GROUP = 50;
const ACTIVE_DUTY_STATUSES = ['assigned', 'enroute', 'in-progress'];

// Favourite doctors and direct duty invites. Hospitals see invite
// candidates without coordinates or contact details; those come only once
// a doctor is assigned to their duty.
class DutyInviteService {
    async _hospitalFor(hospitalUserId, select = '_id favouriteStaff') {
        const hospital = await Hospital.findOne({ user: hospitalUserId }).select(select).lean();
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found. Please complete your profile first.');
        }
        return hospital;
    }



    // --- Favourites ---

    async listFavourites(hospitalUserId) {
        const hospital = await this._hospitalFor(hospitalUserId);
        const ids = hospital.favouriteStaff || [];
        if (!ids.length) return [];
        const staff = await this._loadCards(ids, hospital._id);
        return ids.map(id => staff.get(String(id))).filter(Boolean);
    }

    async addFavourite(hospitalUserId, staffId) {
        const hospital = await this._hospitalFor(hospitalUserId);
        if ((hospital.favouriteStaff || []).length >= MAX_FAVOURITES) {
            throw new ValidationError(`You can keep up to ${MAX_FAVOURITES} favourite doctors`);
        }
        const staff = await MedicalStaff.findOne({ _id: staffId, verificationStatus: 'verified' }).select('_id').lean();
        if (!staff) throw new NotFoundError('Verified doctor not found');

        await Hospital.updateOne({ _id: hospital._id }, { $addToSet: { favouriteStaff: staff._id } });
    }

    async removeFavourite(hospitalUserId, staffId) {
        const hospital = await this._hospitalFor(hospitalUserId);
        await Hospital.updateOne({ _id: hospital._id }, { $pull: { favouriteStaff: new mongoose.Types.ObjectId(staffId) } });
    }



    // --- Invites ---

    // Checks the doctors a hospital wants to invite to a duty of `role`.
    // Returns [{ _id, user: { _id } }] or throws with what is wrong.
    //   hospital: { hospitalId } or { hospitalUserId }, to leave out blocked doctors
    async resolveInvitees(staffIds, role, hospital = {}) {
        const unique = [...new Set((staffIds || []).map(String))];
        if (!unique.length) return [];
        if (unique.length > MAX_INVITEES) {
            throw new ValidationError(`You can invite up to ${MAX_INVITEES} doctors to a duty`);
        }

        const hospitalId = hospital.hospitalId || (hospital.hospitalUserId && (await this._hospitalFor(hospital.hospitalUserId, '_id'))._id);
        if (hospitalId) {
            const hidden = new Set(await blockService.staffHiddenFrom(hospitalId));
            if (unique.some(id => hidden.has(id))) {
                throw new ValidationError('Some invited doctors can no longer be invited');
            }
        }

        const staff = await MedicalStaff.find({ _id: { $in: unique }, verificationStatus: 'verified', isSuspended: { $ne: true } })
            .select('_id user jobRole fullName')
            .lean();
        const wrongRole = staff.filter(s => normalizeRole(s.jobRole) !== normalizeRole(role));
        if (staff.length !== unique.length) {
            throw new ValidationError('Some invited doctors are not verified or no longer active');
        }
        if (wrongRole.length) {
            throw new ValidationError(`These doctors are not ${role}: ${wrongRole.map(s => s.fullName).join(', ')}`);
        }

        return staff.map(s => ({ _id: s._id, user: { _id: s.user } }));
    }

    // Doctors a hospital can invite: favourites, doctors who completed duties
    // there, and verified doctors nearby. Each doctor appears once.
    //   query: { role, date?, start_time?, end_time? }
    async getCandidates(hospitalUserId, { role, date, start_time: startTime, end_time: endTime }) {
        const hospital = await this._hospitalFor(hospitalUserId, '_id favouriteStaff coordinates city');
        const maxRadiusKm = await systemConfigService.getEffective('offer.maxRadiusKm');

        const [workedRows, nearby] = await Promise.all([
            Duty.aggregate([
                { $match: { hospital: hospital._id, status: 'completed', assignedTo: { $ne: null } } },
                { $group: { _id: '$assignedTo', duties: { $sum: 1 }, lastDuty: { $max: '$completedAt' } } },
                { $sort: { duties: -1 } },
                { $limit: CANDIDATES_PER_GROUP * 2 }
            ]),
            hospital.coordinates?.coordinates
                ? staffLocator.findInRadius(hospital.coordinates.coordinates, role, maxRadiusKm)
                : []
        ]);

        const favouriteIds = (hospital.favouriteStaff || []).map(String);
        const workedIds = workedRows.map(r => String(r._id));
        const nearbyIds = nearby.slice(0, CANDIDATES_PER_GROUP).map(r => String(r._id));
        const hidden = new Set(await blockService.staffHiddenFrom(hospital._id));
        const allIds = [...new Set([...favouriteIds, ...workedIds, ...nearbyIds])].filter(id => !hidden.has(id));

        const cards = await this._loadCards(allIds, hospital._id, { role, nearby, workedRows });
        const [clashes, availability] = await Promise.all([
            date && startTime && endTime
                ? this._clashes(allIds, { date: new Date(date), startTime, endTime })
                : new Set(),
            date ? this._availabilityOn(allIds, date, startTime, endTime) : new Map()
        ]);

        const withClash = (id) => {
            const card = cards.get(id);
            if (!card) return null;
            const day = availability.get(id);
            return {
                ...card,
                hasClash: clashes.has(id),
                availabilityOnDate: date ? (day?.status || 'unknown') : null,
                freeForShift: date ? Boolean(day?.freeForShift) : null
            };
        };

        return {
            favourites: favouriteIds.map(withClash).filter(c => c && this._roleMatches(c, role)),
            workedWithYou: workedIds.map(withClash).filter(c => c && this._roleMatches(c, role)).slice(0, CANDIDATES_PER_GROUP),
            nearby: nearbyIds.filter(id => !favouriteIds.includes(id) && !workedIds.includes(id)).map(withClash).filter(Boolean)
        };
    }

    _roleMatches(card, role) {
        return !role || normalizeRole(card.jobRole) === normalizeRole(role);
    }

    // Doctor cards for the invite picker and favourites list
    async _loadCards(ids, hospitalId, { nearby = [], workedRows = null } = {}) {
        const staff = await MedicalStaff.find({ _id: { $in: ids }, verificationStatus: 'verified', isSuspended: { $ne: true } })
            .select('fullName jobRole city user averageRating totalRatings experience isAvailable profilePicture.s3Key')
            .lean();
        if (!staff.length) return new Map();

        const worked = workedRows || await Duty.aggregate([
            { $match: { hospital: hospitalId, status: 'completed', assignedTo: { $in: staff.map(s => s._id) } } },
            { $group: { _id: '$assignedTo', duties: { $sum: 1 }, lastDuty: { $max: '$completedAt' } } }
        ]);
        const workedById = new Map(worked.map(r => [String(r._id), r]));
        const distanceById = new Map(nearby.map(n => [String(n._id), n.distance]));
        const hospital = await Hospital.findById(hospitalId).select('favouriteStaff').lean();
        const favourites = new Set((hospital?.favouriteStaff || []).map(String));

        const ratings = await ratingAlgorithmService.getEffectiveRatingsForMany(staff, 'hospital_to_staff');
        const cards = new Map();
        await Promise.all(staff.map(async (s, i) => {
            let profilePicture = null;
            if (s.profilePicture?.s3Key) {
                try {
                    profilePicture = await s3Service.generatePreSignedURL(s.profilePicture.s3Key);
                } catch (error) {
                    logger.error('Error generating presigned URL for profile picture:', error);
                }
            }
            const id = String(s._id);
            const distance = distanceById.get(id);
            cards.set(id, {
                staffId: s._id,
                name: s.fullName,
                jobRole: s.jobRole,
                city: s.city || null,
                experience: s.experience || null,
                profilePicture,
                effectiveRating: ratings[i]?.ratingShown ?? null,
                isAvailable: Boolean(s.isAvailable),
                isFavourite: favourites.has(id),
                dutiesWithYou: workedById.get(id)?.duties || 0,
                lastDutyWithYou: workedById.get(id)?.lastDuty || null,
                distanceKm: distance === undefined ? null : Math.round(distance)
            });
        }));
        return cards;
    }

    // Doctors already booked for an overlapping shift
    async _clashes(staffIds, shift) {
        const duties = await Duty.find({
            assignedTo: { $in: staffIds },
            status: { $in: ACTIVE_DUTY_STATUSES },
            date: { $gte: new Date(shift.date.getTime() - 24 * 60 * 60 * 1000), $lte: new Date(shift.date.getTime() + 24 * 60 * 60 * 1000) }
        }).select('assignedTo date endDate startTime endTime isOvernightDuty').lean();
        return new Set(duties.filter(d => doDutiesOverlap(shift, d)).map(d => String(d.assignedTo)));
    }



    // What each doctor declared for a date: status free/busy/unknown, and
    // whether the given shift fits inside their hours
    async _availabilityOn(staffIds, date, startTime, endTime) {
        const docs = await StaffAvailability.find({ staff: { $in: staffIds } }).lean();
        return new Map(docs.map(d => [String(d.staff), {
            status: resolveDay(d, date).status,
            freeForShift: isFreeFor(d, date, startTime, endTime)
        }]));
    }



    // isFavourite / workedWithYou / dutiesWithYou (and availabilityOnDate when
    // a date is given) for staff lists such as the hospital and admin
    // nearby-staff maps. Adds fields only.
    async annotate(hospitalId, staffList, { date } = {}) {
        if (!hospitalId || !Array.isArray(staffList) || !staffList.length) return staffList;
        try {
            const ids = staffList.map(s => String(s.id)).filter(id => mongoose.Types.ObjectId.isValid(id));
            const [hospital, worked] = await Promise.all([
                Hospital.findById(hospitalId).select('favouriteStaff').lean(),
                mongoose.Types.ObjectId.isValid(String(hospitalId)) && ids.length
                    ? Duty.aggregate([
                        { $match: { hospital: new mongoose.Types.ObjectId(String(hospitalId)), status: 'completed', assignedTo: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) } } },
                        { $group: { _id: '$assignedTo', duties: { $sum: 1 } } }
                    ])
                    : []
            ]);
            const favourites = new Set((hospital?.favouriteStaff || []).map(String));
            const dutiesById = new Map(worked.map(r => [String(r._id), r.duties]));
            const availability = date && ids.length ? await this._availabilityOn(ids, date) : null;
            for (const s of staffList) {
                const id = String(s.id);
                s.isFavourite = favourites.has(id);
                s.dutiesWithYou = dutiesById.get(id) || 0;
                s.workedWithYou = s.dutiesWithYou > 0;
                if (availability) s.availabilityOnDate = availability.get(id)?.status || 'unknown';
            }
        } catch (error) {
            logger.error('Error annotating staff list:', error);
        }
        return staffList;
    }
}

module.exports = new DutyInviteService();
