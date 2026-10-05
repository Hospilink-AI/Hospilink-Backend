const Duty = require('../models/Duty');
const Hospital = require('../models/Hospital');
const systemConfigService = require('./systemConfig.service');
const staffLocator = require('./staffLocator.service');
const notificationEmitter = require('./notificationEmitter');
const cacheService = require('./cache.service');
const logger = require('../utils/logger');

const staffAvailabilityService = require('./staffAvailability.service');
const blockService = require('./block.service');
const { istDateKey } = require('../utils/calendar.helper');

const OFFER_KEYS = [
    'offer.featureEnabled', 'offer.startRadiusKm', 'offer.stepKm', 'offer.stepMinutes', 'offer.maxRadiusKm',
    'offer.inviteWindowMinutes', 'offer.availabilityHeadStartMinutes'
];
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
            maxRadiusKm: cfg['offer.maxRadiusKm'],
            inviteWindowMinutes: cfg['offer.inviteWindowMinutes'],
            headStartMinutes: cfg['offer.availabilityHeadStartMinutes']
        };
    }

    // Doctors in a ring who marked themselves free for this shift hear first;
    // the rest headStartMinutes later. If nobody in the ring has marked
    // themselves free, everyone hears at once.
    async _prioritise(recipients, duty, settings, now) {
        if (!recipients.length || !(settings.headStartMinutes > 0) || !duty.date) {
            return { notifyNow: recipients, pending: [], releaseAt: null };
        }
        const free = await staffAvailabilityService.freeFor(
            recipients.map(r => r._id), istDateKey(duty.date), duty.startTime, duty.endTime
        );
        if (!free.size || free.size === recipients.length) {
            return { notifyNow: recipients, pending: [], releaseAt: null };
        }
        return {
            notifyNow: recipients.filter(r => free.has(String(r._id))),
            pending: recipients.filter(r => !free.has(String(r._id))).map(r => ({ staff: r._id, user: r.user._id })),
            releaseAt: new Date(now.getTime() + settings.headStartMinutes * MINUTE_MS)
        };
    }

    isStaged(duty) {
        return Boolean(duty?.offer?.mode);
    }



    // Sets up the offer on newly created duties (all slots of one post share
    // it). Returns { userIds, invited }: the users to notify now and whether
    // they are invitees (notified with DUTY_INVITE by the caller's emitter).
    // Returns null when staged offers are switched off, so the caller keeps
    // the old behaviour.
    //   invite: { staff: [{ _id, user: { _id } }], openAfterInvite }
    async startOffer(duties, hospital, invite = null) {
        const settings = await this.getSettings();
        if (!settings.enabled || !duties.length) return null;

        const first = duties[0];
        const now = new Date();
        const ids = duties.map(d => d._id);
        const openTo = first.urgency === 'emergency' ? 'city' : 'radius';

        let offer;
        let recipients;
        if (invite?.staff?.length) {
            recipients = invite.staff;
            offer = {
                mode: 'invite',
                invitedStaff: recipients.map(r => r._id),
                openAfterInvite: invite.openAfterInvite !== false,
                openTo,
                nextActionAt: invite.openAfterInvite !== false
                    ? new Date(now.getTime() + settings.inviteWindowMinutes * MINUTE_MS)
                    : null,
                history: [{ at: now, event: 'invite_sent', notified: recipients.length }]
            };
        } else {
            ({ offer, recipients } = await this._openOffer(openTo, hospital, first.staffRole, settings, now));
            offer.history = [offer.historyEntry];
            delete offer.historyEntry;

            // Emergencies go to everyone at once; rings give free doctors a head start
            if (offer.mode === 'radius') {
                const { notifyNow, pending, releaseAt } = await this._prioritise(recipients, first, settings, now);
                recipients = notifyNow;
                if (pending.length) {
                    offer.pendingStaff = pending;
                    offer.pendingReleaseAt = releaseAt;
                }
            }
        }

        await Duty.updateMany(
            { _id: { $in: ids } },
            { $set: { offer: { ...offer, notifiedStaff: recipients.map(r => r._id) } } }
        );
        for (const duty of duties) duty.offer = offer;

        return { userIds: recipients.map(r => String(r.user._id)), invited: offer.mode === 'invite' };
    }



    // The offer fields and first recipients for a duty opening to the city
    // (emergency) or the first ring
    async _openOffer(openTo, hospital, role, settings, now, excludeStaffIds = []) {
        excludeStaffIds = [...excludeStaffIds, ...(await blockService.staffHiddenFrom(hospital._id))];
        if (openTo === 'city') {
            const recipients = await staffLocator.findInCity(hospital.city, role, { excludeStaffIds, demo: !!hospital.isDemo });
            return {
                recipients,
                offer: {
                    mode: 'city',
                    city: staffLocator.normalizeCity(hospital.city),
                    nextActionAt: null,
                    historyEntry: { at: now, event: 'opened_to_city', notified: recipients.length }
                }
            };
        }

        const center = this._hospitalPoint(hospital);
        const recipients = center
            ? await staffLocator.findInRadius(center, role, settings.startRadiusKm, { excludeStaffIds, demo: !!hospital.isDemo })
            : [];
        return {
            recipients,
            offer: {
                mode: 'radius',
                radiusKm: settings.startRadiusKm,
                maxRadiusKm: settings.maxRadiusKm,
                stepKm: settings.stepKm,
                stepMinutes: settings.stepMinutes,
                nextActionAt: settings.startRadiusKm < settings.maxRadiusKm
                    ? new Date(now.getTime() + settings.stepMinutes * MINUTE_MS)
                    : null,
                historyEntry: { at: now, event: 'opened', radiusKm: settings.startRadiusKm, notified: recipients.length }
            }
        };
    }



    // Invite window over with nobody accepting: open to the city or first ring
    async _openAfterInvite(duty) {
        const settings = await this.getSettings();
        const hospital = await Hospital.findById(duty.hospital).select('coordinates city user hospitalLegalName isDemo');
        if (!hospital) return false;

        const now = new Date();
        const already = (duty.offer.notifiedStaff || []).map(String);
        const opened = await this._openOffer(duty.offer.openTo || 'radius', hospital, duty.staffRole, settings, now, already);
        const offer = opened.offer;
        let recipients = opened.recipients;
        const historyEntry = { ...offer.historyEntry, event: offer.mode === 'city' ? 'opened_to_city' : 'opened_to_radius' };
        delete offer.historyEntry;

        if (offer.mode === 'radius') {
            const { notifyNow, pending, releaseAt } = await this._prioritise(recipients, duty, settings, now);
            recipients = notifyNow;
            if (pending.length) {
                offer.pendingStaff = pending;
                offer.pendingReleaseAt = releaseAt;
            }
        }

        const updated = await Duty.findOneAndUpdate(
            { _id: duty._id, status: 'available', 'offer.mode': 'invite' },
            {
                $set: Object.fromEntries(Object.entries(offer).map(([k, v]) => [`offer.${k}`, v])),
                $addToSet: { 'offer.notifiedStaff': { $each: recipients.map(r => r._id) } },
                $push: { 'offer.history': historyEntry }
            },
            { new: true }
        );
        if (!updated) return false;

        if (recipients.length) {
            await notificationEmitter.emitDutyOfferWidened(updated, recipients.map(r => String(r.user._id)), offer.radiusKm ?? null, hospital.hospitalLegalName);
        }

        // Let the hospital know its invitees didn't take it and who it went to next
        const reach = offer.mode === 'city' ? 'every doctor in your city' : `doctors within ${offer.radiusKm} km`;
        await notificationEmitter.emitDutyNotice('DUTY_OPENED_TO_OTHERS', updated, [hospital.user],
            `None of the doctors you invited accepted your ${notificationEmitter.describeShift(updated)}, so it is now open to ${reach}.`,
            { offer: { mode: offer.mode, radiusKm: offer.radiusKm ?? null } });
        return true;
    }



    // Widens every duty whose next step is due. Safe to call often: a lock
    // keeps two runs from overlapping.
    async runDue() {
        const locked = await cacheService.acquireLock('duty-offer:run', 240);
        if (!locked) return 0;

        try {
            const now = new Date();
            const due = await Duty.find({
                status: 'available',
                'offer.mode': { $in: ['radius', 'invite'] },
                $or: [
                    { 'offer.nextActionAt': { $lte: now } },
                    { 'offer.pendingReleaseAt': { $lte: now } }
                ]
            }).select('+offer.notifiedStaff +offer.pendingStaff staffRole date startTime endTime urgency offeredRate hospital offer');

            let widened = 0;
            for (const duty of due) {
                try {
                    if (duty.offer.pendingReleaseAt && duty.offer.pendingReleaseAt <= now) {
                        await this._releasePending(duty);
                    }
                    if (!duty.offer.nextActionAt || duty.offer.nextActionAt > now) continue;

                    const done = duty.offer.mode === 'invite'
                        ? await this._openAfterInvite(duty)
                        : await this._widen(duty);
                    if (done) widened++;
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



    // Head start over: tell the doctors in range who weren't marked free
    async _releasePending(duty) {
        const pending = duty.offer.pendingStaff || [];
        const updated = await Duty.findOneAndUpdate(
            { _id: duty._id, 'offer.pendingReleaseAt': duty.offer.pendingReleaseAt },
            {
                $set: { 'offer.pendingStaff': [], 'offer.pendingReleaseAt': null },
                $addToSet: { 'offer.notifiedStaff': { $each: pending.map(p => p.staff) } }
            },
            { new: true }
        );
        if (!updated) return false;

        // Keep the in-memory copy current so a widen in the same run skips them
        duty.offer.notifiedStaff = [...(duty.offer.notifiedStaff || []), ...pending.map(p => p.staff)];
        duty.offer.pendingStaff = [];
        duty.offer.pendingReleaseAt = null;

        if (pending.length && updated.status === 'available') {
            const hospital = await Hospital.findById(duty.hospital).select('hospitalLegalName').lean();
            await notificationEmitter.emitDutyOfferWidened(updated, pending.map(p => String(p.user)), updated.offer.radiusKm ?? null, hospital?.hospitalLegalName);
        }
        return true;
    }



    async _widen(duty) {
        const offer = duty.offer;
        const radiusKm = Math.min(offer.radiusKm + offer.stepKm, offer.maxRadiusKm);
        const hospital = await Hospital.findById(duty.hospital).select('coordinates city user hospitalLegalName isDemo');
        const center = this._hospitalPoint(hospital);
        if (!center) return false;

        const already = [
            ...(offer.notifiedStaff || []),
            ...(offer.pendingStaff || []).map(p => p.staff),
            ...(await blockService.staffHiddenFrom(hospital._id))
        ].map(String);
        const found = await staffLocator.findInRadius(center, duty.staffRole, radiusKm, { excludeStaffIds: already, demo: !!hospital.isDemo });
        const now = new Date();
        const settings = await this.getSettings();
        const { notifyNow: recipients, pending, releaseAt } = await this._prioritise(found, duty, settings, now);

        const updated = await Duty.findOneAndUpdate(
            { _id: duty._id, status: 'available', 'offer.radiusKm': offer.radiusKm },
            {
                $set: {
                    'offer.radiusKm': radiusKm,
                    'offer.nextActionAt': radiusKm < offer.maxRadiusKm ? new Date(now.getTime() + offer.stepMinutes * MINUTE_MS) : null,
                    ...(pending.length && { 'offer.pendingReleaseAt': releaseAt })
                },
                $addToSet: { 'offer.notifiedStaff': { $each: recipients.map(r => r._id) } },
                $push: {
                    'offer.history': { at: now, event: 'expanded', radiusKm, notified: found.length },
                    ...(pending.length && { 'offer.pendingStaff': { $each: pending } })
                }
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
        // Store reviewer demo accounts and real ones never meet
        if (Boolean(duty.isDemo) !== Boolean(medicalStaff.isDemo)) return false;
        if (await blockService.isBlocked(duty.hospital?._id || duty.hospital, medicalStaff._id)) return false;
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
