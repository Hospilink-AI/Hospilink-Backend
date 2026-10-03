const JobVacancy = require('../../models/JobVacancy');
const JobApplication = require('../../models/JobApplication');
const { splitByPeriod } = require('./dutyData');
const { tile, ratio, median, countBy, seriesFromRows } = require('../../utils/analytics.helper');

// Furthest stage an application reached, from its history and current status
const STAGES = [
    { key: 'applied', label: 'Applied', statuses: null },
    { key: 'shortlisted', label: 'Shortlisted', statuses: ['shortlisted', 'slots_offered', 'slot_selected', 'confirmed', 'interviewed', 'offered', 'hired'] },
    { key: 'interviewConfirmed', label: 'Interview confirmed', statuses: ['confirmed', 'interviewed', 'offered', 'hired'] },
    { key: 'interviewed', label: 'Interviewed', statuses: ['interviewed', 'offered', 'hired'] },
    { key: 'offered', label: 'Offered', statuses: ['offered', 'hired'] },
    { key: 'hired', label: 'Hired', statuses: ['hired'] }
];

const SELECT = [
    'appliedAt createdAt status statusHistory.status statusHistory.timestamp vacancy hospitalId',
    'rejectionReason withdrawReason matchScoreSnapshot.gateTier contactRelease.releasedAt',
    'interview.confirmedAt interview.rescheduleCount interview.outcome.result interview.noShow.by'
].join(' ');

const appliedOn = (a) => a.appliedAt || a.createdAt;
const reached = (application, stage) => {
    if (!stage.statuses) return true;
    const seen = new Set([application.status, ...(application.statusHistory || []).map(h => h.status)]);
    return stage.statuses.some(s => seen.has(s));
};
const hiredAt = (a) => {
    if (a.contactRelease?.releasedAt) return new Date(a.contactRelease.releasedAt);
    const entry = (a.statusHistory || []).find(h => h.status === 'hired');
    return entry ? new Date(entry.timestamp) : null;
};
const daysBetween = (from, to) => (new Date(to) - new Date(from)) / (24 * 3600000);

class RecruitmentAnalytics {
    // Applications are counted by the day they were made; filters apply to
    // duties only, so this section ignores them
    async build(period) {
        const range = { $gte: period.compareStart, $lt: period.end };

        const [vacancies, liveVacancies, applications] = await Promise.all([
            JobVacancy.find({ createdAt: range }).select('createdAt specialty').lean(),
            JobVacancy.countDocuments({ deletedAt: null }),
            JobApplication.find({ $or: [{ appliedAt: range }, { appliedAt: null, createdAt: range }] }).select(SELECT).lean()
        ]);

        const vacancySplit = splitByPeriod(vacancies, v => v.createdAt, period);
        const appSplit = splitByPeriod(applications, appliedOn, period);

        const measure = (vacancyRows, apps) => {
            const interviewed = apps.filter(a => a.interview?.outcome?.result);
            const offered = apps.filter(a => reached(a, STAGES[4]));
            const hired = apps.filter(a => a.status === 'hired');
            const confirmed = apps.filter(a => a.interview?.confirmedAt);
            return {
                vacancies: vacancyRows.length,
                applications: apps.length,
                applicationsPerVacancy: ratio(apps.length, new Set(apps.map(a => a.vacancy?.toString())).size, 2),
                shortlistRate: ratio(apps.filter(a => reached(a, STAGES[1])).length, apps.length),
                hires: hired.length,
                hireRate: ratio(hired.length, apps.length),
                medianDaysToHire: median(hired.map(a => (hiredAt(a) ? daysBetween(appliedOn(a), hiredAt(a)) : null)).filter(d => d !== null)),
                candidateNoShowRate: ratio(interviewed.filter(a => a.interview.noShow?.by === 'candidate').length, interviewed.length),
                hospitalNoShowRate: ratio(interviewed.filter(a => a.interview.noShow?.by === 'hospital').length, interviewed.length),
                rescheduleRate: ratio(confirmed.filter(a => (a.interview.rescheduleCount || 0) > 0).length, confirmed.length),
                offerAcceptance: ratio(offered.filter(a => a.status === 'hired').length, offered.filter(a => ['hired', 'rejected', 'withdrawn'].includes(a.status)).length)
            };
        };

        const cur = measure(vacancySplit.current, appSplit.current);
        const prev = measure(vacancySplit.previous, appSplit.previous);

        const tiles = [
            tile('vacanciesPosted', 'Vacancies posted', cur.vacancies, prev.vacancies, 'count'),
            tile('liveVacancies', 'Live vacancies now', liveVacancies, null, 'count'),
            tile('applications', 'Applications', cur.applications, prev.applications, 'count'),
            tile('applicationsPerVacancy', 'Applications per vacancy applied to', cur.applicationsPerVacancy, prev.applicationsPerVacancy, 'ratio'),
            tile('shortlistRate', 'Applications shortlisted', cur.shortlistRate, prev.shortlistRate, 'ratio'),
            tile('hires', 'Hires', cur.hires, prev.hires, 'count'),
            tile('hireRate', 'Applications that led to a hire', cur.hireRate, prev.hireRate, 'ratio'),
            tile('timeToHire', 'Median days from application to hire', cur.medianDaysToHire, prev.medianDaysToHire, 'days'),
            tile('offerAcceptance', 'Offers accepted', cur.offerAcceptance, prev.offerAcceptance, 'ratio'),
            tile('candidateNoShowRate', 'Interviews the candidate missed', cur.candidateNoShowRate, prev.candidateNoShowRate, 'ratio'),
            tile('hospitalNoShowRate', 'Interviews the hospital missed', cur.hospitalNoShowRate, prev.hospitalNoShowRate, 'ratio'),
            tile('rescheduleRate', 'Confirmed interviews rescheduled', cur.rescheduleRate, prev.rescheduleRate, 'ratio')
        ];

        const apps = appSplit.current;
        const charts = [
            {
                key: 'applicationTrend',
                type: 'line',
                title: 'Applications and hires',
                series: seriesFromRows(apps, appliedOn, period, { applications: () => 1, hired: a => (a.status === 'hired' ? 1 : 0) })
            },
            {
                key: 'hiringFunnel',
                type: 'funnel',
                title: 'How far applications got',
                stages: STAGES.map(stage => ({ key: stage.key, label: stage.label, value: apps.filter(a => reached(a, stage)).length }))
            },
            { key: 'vacanciesBySpecialty', type: 'table', title: 'Vacancies posted by specialty', rows: countBy(vacancySplit.current, v => v.specialty) },
            { key: 'rejectionReasons', type: 'donut', title: 'Why hospitals rejected', rows: countBy(apps, a => a.rejectionReason) },
            { key: 'withdrawReasons', type: 'donut', title: 'Why candidates withdrew', rows: countBy(apps, a => a.withdrawReason) },
            { key: 'matchTierHires', type: 'table', title: 'Hire rate by match tier', rows: this._byTier(apps) },
            { key: 'statusNow', type: 'bar', title: 'Where applications are now', rows: countBy(apps, a => a.status) }
        ];

        return {
            tiles,
            charts,
            dataNotes: [
                'Applications are counted on the day they were made, so recent ones may still be in progress.',
                'Role, urgency and city filters apply to duties and are ignored here.'
            ]
        };
    }



    _byTier(apps) {
        return ['exact', 'related', 'unscored'].map(tier => {
            const list = apps.filter(a => (a.matchScoreSnapshot?.gateTier || 'unscored') === tier);
            return {
                tier,
                applications: list.length,
                shortlistRate: ratio(list.filter(a => reached(a, STAGES[1])).length, list.length),
                hireRate: ratio(list.filter(a => a.status === 'hired').length, list.length)
            };
        });
    }
}

module.exports = new RecruitmentAnalytics();
