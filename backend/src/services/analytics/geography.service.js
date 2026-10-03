const Hospital = require('../../models/Hospital');
const MedicalStaff = require('../../models/MedicalStaff');
const { loadDuties, wasFilled, wasWithdrawn } = require('./dutyData');
const { tile, ratio, round, sum, dutyHours } = require('../../utils/analytics.helper');

// A city needs this many posts in the period before it can be called short of staff
const SHORTAGE_MIN_POSTED = 5;
const SHORTAGE_MAX_FILL_RATE = 0.6;

const placeKey = (value) => (value || '').trim().toLowerCase();

class GeographyAnalytics {
    // Demand is placed by the hospital's city, supply by the staff profile's city
    async build(period, filters) {
        const [hospitals, staff, posted, completed] = await Promise.all([
            Hospital.find({}).select('city state verificationStatus isSuspended').lean(),
            MedicalStaff.find({ verificationStatus: 'verified', isSuspended: { $ne: true } }).select('city state isAvailable').lean(),
            loadDuties('createdAt', period.start, period.end, filters, 'hospital status assignedTo cancellation.cancelledBy'),
            loadDuties('completedAt', period.start, period.end, filters, 'hospital offeredRate totalPayment', { status: 'completed' })
        ]);

        const hospitalById = new Map(hospitals.map(h => [h._id.toString(), h]));
        const cities = new Map();
        const cityFor = (name, state) => {
            const key = placeKey(name);
            if (!key) return null;
            if (!cities.has(key)) {
                cities.set(key, {
                    city: name.trim(), state: state || null,
                    verifiedHospitals: 0, verifiedStaff: 0, availableStaff: 0,
                    posted: 0, filled: 0, withdrawn: 0, completed: 0, gmvCompleted: 0, hours: 0
                });
            }
            return cities.get(key);
        };

        for (const h of hospitals) {
            if (h.verificationStatus === 'verified' && !h.isSuspended) {
                const c = cityFor(h.city, h.state);
                if (c) c.verifiedHospitals++;
            }
        }
        for (const s of staff) {
            const c = cityFor(s.city, s.state);
            if (!c) continue;
            c.verifiedStaff++;
            if (s.isAvailable) c.availableStaff++;
        }
        for (const duty of posted) {
            const h = hospitalById.get(duty.hospital?.toString());
            const c = h && cityFor(h.city, h.state);
            if (!c) continue;
            c.posted++;
            if (wasFilled(duty)) c.filled++;
            if (wasWithdrawn(duty)) c.withdrawn++;
        }
        for (const duty of completed) {
            const h = hospitalById.get(duty.hospital?.toString());
            const c = h && cityFor(h.city, h.state);
            if (!c) continue;
            c.completed++;
            c.gmvCompleted += duty.totalPayment || 0;
            c.hours += dutyHours(duty);
        }

        const rows = [...cities.values()].map(c => ({
            city: c.city,
            state: c.state,
            verifiedHospitals: c.verifiedHospitals,
            verifiedStaff: c.verifiedStaff,
            availableStaff: c.availableStaff,
            posted: c.posted,
            fillRate: ratio(c.filled, c.posted - c.withdrawn),
            completed: c.completed,
            gmvCompleted: round(c.gmvCompleted),
            averageHourlyRate: ratio(c.gmvCompleted, c.hours, 2),
            dutiesPerAvailableStaff: ratio(c.posted, c.availableStaff, 2)
        })).sort((a, b) => b.posted - a.posted || b.verifiedStaff - a.verifiedStaff);

        const shortage = rows
            .filter(r => r.posted >= SHORTAGE_MIN_POSTED && r.fillRate !== null && r.fillRate < SHORTAGE_MAX_FILL_RATE)
            .sort((a, b) => a.fillRate - b.fillRate);

        const states = new Map();
        for (const r of rows) {
            const key = placeKey(r.state) || 'unknown';
            const s = states.get(key) || { state: r.state || 'Unknown', cities: 0, verifiedHospitals: 0, verifiedStaff: 0, posted: 0, completed: 0, gmvCompleted: 0 };
            s.cities++;
            s.verifiedHospitals += r.verifiedHospitals;
            s.verifiedStaff += r.verifiedStaff;
            s.posted += r.posted;
            s.completed += r.completed;
            s.gmvCompleted += r.gmvCompleted;
            states.set(key, s);
        }

        const withDemand = rows.filter(r => r.posted > 0);
        const tiles = [
            tile('citiesWithDemand', 'Cities with duties posted', withDemand.length, null, 'count'),
            tile('citiesWithSupply', 'Cities with verified staff', rows.filter(r => r.verifiedStaff > 0).length, null, 'count'),
            tile('shortageCities', 'Cities short of staff', shortage.length, null, 'count'),
            tile('demandWithoutSupply', 'Cities with demand but no available staff', withDemand.filter(r => r.availableStaff === 0).length, null, 'count'),
            tile('topCityShare', 'Share of posts from the busiest city', ratio(withDemand[0]?.posted || 0, sum(rows.map(r => r.posted))), null, 'ratio')
        ];

        const charts = [
            { key: 'cities', type: 'table', title: 'Cities', rows },
            { key: 'shortageCities', type: 'table', title: `Cities with ${SHORTAGE_MIN_POSTED}+ posts and fill rate under ${SHORTAGE_MAX_FILL_RATE * 100}%`, rows: shortage },
            { key: 'states', type: 'table', title: 'States', rows: [...states.values()].map(s => ({ ...s, gmvCompleted: round(s.gmvCompleted) })).sort((a, b) => b.posted - a.posted) }
        ];

        return {
            tiles,
            charts,
            dataNotes: [
                'Cities are typed in by users, so spelling variants of one city may show as separate rows.',
                'Staff and hospital counts are as of now; duties are for the selected period.'
            ]
        };
    }
}

module.exports = new GeographyAnalytics();
