const Duty = require('../models/Duty');
const Hospital = require('../models/Hospital');
const systemConfigService = require('./systemConfig.service');
const staffLocator = require('./staffLocator.service');
const notificationEmitter = require('./notificationEmitter');
const cacheService = require('./cache.service');
const logger = require('../utils/logger');

const OFFER_KEYS = ['offer.featureEnabled', 'offer.startRadiusKm', 'offer.stepKm', 'offer.stepMinutes', 'offer.maxRadiusKm'];
const MINUTE_MS = 60 * 1000;

// Staged duty offers. A normal duty is offered to doctors within
// startRadiusKm and widens by stepKm every stepMinutes up to maxRadiusKm; an
// emergency duty goes to every doctor in the hospital's city at once. A
// doctor sees and can accept a staged duty only while it is offered to them.
class DutyOfferService {
    async getSettings() {
        const cfg = await systemConfigService.getManyEffective(OFFER_KEYS);
        return {
            enabled: cfg['offer.featureEnabled'] !== false,
            startRadiusKm: cfg['offer.startRadiusKm'],
            stepKm: cfg['offer.stepKm'],
            stepMinutes: cfg['offer.stepMinutes'],
            maxRadiusKm: cfg['offer.maxRadiusKm']
        };
    }

    isStaged(duty) {
        return Boolean(duty?.offer?.mode);
    }



    // Sets up the offer on newly created duties (all slots of one post share
    // it) and returns the user ids to notify now. Returns null when staged
    // offers are switched off, so the caller keeps the old behaviour.
    async startOffer(duties, hospital) {
        const settings = await this.getSettings();
        if (!settings.enabled || !duties.length) return null;

        const first = duties[0];
        const now = new Date();
        const ids = duties.map(d => d._id);
        const center = this._hospitalPoint(hospital);

        let offer;
        let recipients;
        if (first.urgency === 'emergency') {
            const city = staffLocator.normalizeCity(hospital.city);
            recipients = await staffLocator.findInCity(hospital.city, first.staffRole);
            offer = {
                mode: 'city',
                city,
                history: [{ at: now, event: 'opened_to_city', notified: recipients.length }]
            };
        } else {
            recipients = center ? await staffLocator.findInRadius(center, first.staffRole, settings.startRadiusKm) : [];
            offer = {
                mode: 'radius',
                radiusKm: settings.startRadiusKm,
                maxRadiusKm: settings.maxRadiusKm,
                stepKm: settings.stepKm,
                stepMinutes: settings.stepMinutes,
                nextActionAt: settings.startRadiusKm < settings.maxRadiusKm
                    ? new Date(now.getTime() + settings.stepMinutes * MINUTE_MS)
                    : null,
                history: [{ at: now, event: 'opened', radiusKm: settings.startRadiusKm, notified: recipients.length }]
            };
        }

        await Duty.updateMany(
            { _id: { $in: ids } },
            { $set: { offer: { ...offer, notifiedStaff: recipients.map(r => r._id) } } }
        );
        for (const duty of duties) duty.offer = offer;

        return recipients.map(r => String(r.user._id));
    }



    // Widens every duty whose next step is due. Safe to call often: a lock
    // keeps two runs from overlapping.
    async runDue() {
        const locked = await cacheService.acquireLock('duty-offer:run', 240);
        if (!locked) return 0;

        try {
            const due = await Duty.find({
                status: 'available',
                'offer.mode': 'radius',
                'offer.nextActionAt': { $lte: new Date() }
            }).select('+offer.notifiedStaff staffRole date startTime urgency offeredRate hospital offer');

            let widened = 0;
            for (const duty of due) {
                try {
                    if (await this._widen(duty)) widened++;
                } catch (error) {
                    logger.error(`Error widening offer for duty ${duty._id}:`, error);
                }
            }
            return widened;
        } finally {
            await cacheService.releaseLock('duty-offer:run');
        }
    }

    // At most once a minute from read paths, for deployments without crons
    async runDueThrottled() {
        try {
            const first = await cacheService.acquireLock('duty-offer:recent', 60);
            if (first) await this.runDue();
        } catch (error) {
            logger.error('Error running due duty offers:', error);
        }
    }



    async _widen(duty) {
        const offer = duty.offer;
        const radiusKm = Math.min(offer.radiusKm + offer.stepKm, offer.maxRadiusKm);
        const hospital = await Hospital.findById(duty.hospital).select('coordinates city user hospitalLegalName');
        const center = this._hospitalPoint(hospital);
        if (!center) return false;

        const already = (offer.notifiedStaff || []).map(String);
        const recipients = await staffLocator.findInRadius(center, duty.staffRole, radiusKm, { excludeStaffIds: already });
        const now = new Date();

        const updated = await Duty.findOneAndUpdate(
            { _id: duty._id, status: 'available', 'offer.radiusKm': offer.radiusKm },
            {
                $set: {
                    'offer.radiusKm': radiusKm,
                    'offer.nextActionAt': radiusKm < offer.maxRadiusKm ? new Date(now.getTime() + offer.stepMinutes * MINUTE_MS) : null
                },
                $addToSet: { 'offer.notifiedStaff': { $each: recipients.map(r => r._id) } },
                $push: { 'offer.history': { at: now, event: 'expanded', radiusKm, notified: recipients.length } }
            },
            { new: true }
        );
        if (!updated) return false;

        if (recipients.length) {
            await notificationEmitter.emitDutyOfferWidened(updated, recipients.map(r => String(r.user._id)), radiusKm, hospital.hospitalLegalName);
        }
        return true;
    }



    // After a staff cancellation the relist goes out at the relist radius, so
    // a staged duty opens that far, stops widening, and everyone told about
    // the relist can see it.
    async onRelist(duty, notifiedStaffIds, radiusKm) {
        if (!this.isStaged(duty)) return;

        await Duty.updateOne(
            { _id: duty._id },
            { $addToSet: { 'offer.notifiedStaff': { $each: notifiedStaffIds } } }
        );
        await Duty.updateOne(
            { _id: duty._id, 'offer.mode': 'radius', 'offer.radiusKm': { $lt: radiusKm } },
            {
                $set: { 'offer.radiusKm': radiusKm, 'offer.nextActionAt': null },
                $push: { 'offer.history': { at: new Date(), event: 'opened_fully', radiusKm } }
            }
        );
    }



    // Staged duties in `duties` that this doctor has been notified about
    async notifiedAmong(duties, medicalStaffId) {
        const staged = duties.filter(d => this.isStaged(d)).map(d => d._id);
        if (!staged.length) return new Set();
        const rows = await Duty.find({ _id: { $in: staged }, 'offer.notifiedStaff': medicalStaffId }).select('_id').lean();
        return new Set(rows.map(r => String(r._id)));
    }

    // Can this doctor see and accept the duty right now? Legacy duties
    // (no offer) are always eligible here; their old 50 km rule applies elsewhere.
    //   duty: needs offer, hospital (populated with coordinates and city for staged)
    //   position: the doctor's { latitude, longitude } (live or home), or null
    eligibility(duty, medicalStaff, position, notified) {
        if (!this.isStaged(duty)) return { eligible: true, legacy: true };
        if (notified) return { eligible: true };

        const offer = duty.offer;
        if (offer.mode === 'city') {
            return { eligible: staffLocator.normalizeCity(medicalStaff.city) === offer.city };
        }
        if (offer.mode === 'radius') {
            const center = this._hospitalPoint(duty.hospital);
            if (!center || !position) return { eligible: false };
            const distance = staffLocator.haversineKm(center.latitude, center.longitude, position.latitude, position.longitude);
            return { eligible: distance <= offer.radiusKm, distance };
        }
        return { eligible: false };
    }

    // Eligibility for one duty, loading what it needs
    async isEligible(duty, medicalStaff) {
        if (!this.isStaged(duty)) return true;
        const notified = (await this.notifiedAmong([duty], medicalStaff._id)).has(String(duty._id));
        if (notified) return true;

        let hospital = duty.hospital;
        if (!hospital?.coordinates) {
            hospital = await Hospital.findById(duty.hospital?._id || duty.hospital).select('coordinates city').lean();
        }
        const position = await staffLocator.positionOf(medicalStaff);
        return this.eligibility({ ...this._plain(duty), hospital }, medicalStaff, position, false).eligible;
    }



    _plain(duty) {
        return typeof duty.toObject === 'function' ? duty.toObject() : duty;
    }

    _hospitalPoint(hospital) {
        const c = hospital?.coordinates?.coordinates;
        return c && typeof c.latitude === 'number' ? { latitude: c.latitude, longitude: c.longitude } : null;
    }
}

module.exports = new DutyOfferService();
