const Ticket = require('../../models/Ticket');
const TicketConversation = require('../../models/TicketConversation');
const PlatformFeedback = require('../../models/PlatformFeedback');
const User = require('../../models/User');
const { ACTIVE_STATUSES } = require('../../utils/ticket.constants');
const { splitByPeriod } = require('./dutyData');
const { tile, ratio, median, countBy, seriesFromRows } = require('../../utils/analytics.helper');

const DAY_MS = 24 * 60 * 60 * 1000;
const WAITING_STATUSES = ['NEW', 'TRIAGE'];
const CLOSING_STATUSES = ['RESOLVED', 'REJECTED', 'WITHDRAWN', 'DUPLICATE', 'AUTO_CLOSED', 'CLOSED'];
const OVERTURN_OUTCOMES = ['OVERTURNED', 'VARIED'];

const BACKLOG_AGE_BANDS = [
    { key: 'under1d', label: 'Under 1 day', max: 1 },
    { key: '1to3d', label: '1-3 days', max: 3 },
    { key: '3to7d', label: '3-7 days', max: 7 },
    { key: 'over7d', label: 'Over 7 days', max: Infinity }
];

// First time the ticket left the intake statuses, or was claimed
function acknowledgedAt(ticket) {
    const moved = (ticket.statusHistory || []).find(h => !WAITING_STATUSES.includes(h.status));
    const candidates = [ticket.claimedAt, moved?.timestamp].filter(Boolean).map(d => new Date(d));
    return candidates.length ? new Date(Math.min(...candidates)) : null;
}

function closedAt(ticket) {
    const entry = (ticket.statusHistory || []).find(h => CLOSING_STATUSES.includes(h.status));
    return entry ? new Date(entry.timestamp) : null;
}

const hoursBetween = (from, to) => (new Date(to) - new Date(from)) / 3600000;
const metWithin = (at, deadline) => (at && deadline ? new Date(at) <= new Date(deadline) : null);
const shareMet = (results) => ratio(results.filter(r => r === true).length, results.filter(r => r !== null).length);

const SELECT = [
    'createdAt domain category botCategory source language priority status resolutionOutcome appealOf assignedTo',
    'claimedAt firstReplyAt slaAcknowledgeBy slaFirstReplyBy slaDecideBy statusHistory.status statusHistory.timestamp'
].join(' ');

class SupportAnalytics {
    // Tickets are counted by the day they were raised
    async build(period) {
        const range = { $gte: period.compareStart, $lt: period.end };

        const [tickets, conversations, feedback, backlog] = await Promise.all([
            Ticket.find({ createdAt: range }).select(SELECT).lean(),
            TicketConversation.find({ createdAt: range }).select('createdAt status ticket').lean(),
            PlatformFeedback.find({ createdAt: range }).select('createdAt area sentiment convertedToTicket').lean(),
            Ticket.find({ status: { $in: ACTIVE_STATUSES } }).select('createdAt priority queue').lean()
        ]);

        const ticketSplit = splitByPeriod(tickets, t => t.createdAt, period);
        const conversationSplit = splitByPeriod(conversations, c => c.createdAt, period);
        const feedbackSplit = splitByPeriod(feedback, f => f.createdAt, period);

        const measure = (list, chats) => {
            const closed = list.map(t => ({ t, at: closedAt(t) })).filter(x => x.at);
            const decided = list.filter(t => t.resolutionOutcome && !t.appealOf);
            const appeals = list.filter(t => t.appealOf);
            const botTickets = list.filter(t => t.botCategory);
            const finishedChats = chats.filter(c => c.status !== 'active');
            return {
                tickets: list.length,
                deflection: ratio(finishedChats.filter(c => !c.ticket).length, finishedChats.length),
                botAccuracy: ratio(botTickets.filter(t => t.botCategory === t.category).length, botTickets.length),
                acknowledgeSla: shareMet(list.map(t => metWithin(acknowledgedAt(t), t.slaAcknowledgeBy))),
                firstReplySla: shareMet(list.map(t => metWithin(t.firstReplyAt, t.slaFirstReplyBy))),
                decideSla: shareMet(closed.map(({ t, at }) => metWithin(at, t.slaDecideBy))),
                medianResolutionHours: median(closed.map(({ t, at }) => hoursBetween(t.createdAt, at))),
                appealRate: ratio(appeals.length, decided.length),
                overturnRate: ratio(appeals.filter(t => OVERTURN_OUTCOMES.includes(t.resolutionOutcome)).length, appeals.filter(t => t.resolutionOutcome).length)
            };
        };

        const cur = measure(ticketSplit.current, conversationSplit.current);
        const prev = measure(ticketSplit.previous, conversationSplit.previous);

        const tiles = [
            tile('tickets', 'Tickets raised', cur.tickets, prev.tickets, 'count'),
            tile('openBacklog', 'Open tickets now', backlog.length, null, 'count'),
            tile('chatbotDeflection', 'Chatbot conversations resolved without a ticket', cur.deflection, prev.deflection, 'ratio'),
            tile('botAccuracy', 'Bot category kept by the agent', cur.botAccuracy, prev.botAccuracy, 'ratio'),
            tile('acknowledgeSla', 'Acknowledged within SLA', cur.acknowledgeSla, prev.acknowledgeSla, 'ratio'),
            tile('firstReplySla', 'First reply within SLA', cur.firstReplySla, prev.firstReplySla, 'ratio'),
            tile('decideSla', 'Closed within the decision SLA', cur.decideSla, prev.decideSla, 'ratio'),
            tile('resolutionTime', 'Median time to close', cur.medianResolutionHours, prev.medianResolutionHours, 'hours'),
            tile('appealRate', 'Decisions appealed', cur.appealRate, prev.appealRate, 'ratio'),
            tile('overturnRate', 'Appeals that changed the outcome', cur.overturnRate, prev.overturnRate, 'ratio')
        ];

        const now = ticketSplit.current;
        const charts = [
            {
                key: 'ticketTrend',
                type: 'line',
                title: 'Tickets raised and closed',
                series: this._ticketTrend(now, period)
            },
            { key: 'byDomain', type: 'donut', title: 'Tickets by area', rows: countBy(now, t => t.domain) },
            { key: 'byCategory', type: 'table', title: 'Top categories', rows: countBy(now, t => t.category, 15) },
            { key: 'bySource', type: 'donut', title: 'How tickets were raised', rows: countBy(now, t => t.source) },
            { key: 'byLanguage', type: 'donut', title: 'Language', rows: countBy(now, t => t.language) },
            { key: 'byPriority', type: 'bar', title: 'Priority', rows: countBy(now, t => t.priority) },
            { key: 'outcomes', type: 'donut', title: 'Outcomes', rows: countBy(now, t => t.resolutionOutcome || 'open') },
            { key: 'backlogAge', type: 'bar', title: 'Open tickets by age', rows: this._backlogAge(backlog) },
            { key: 'backlogByQueue', type: 'table', title: 'Open tickets by queue', rows: countBy(backlog, t => t.queue) },
            { key: 'workload', type: 'table', title: 'Tickets closed per admin', rows: await this._workload(now) },
            {
                key: 'feedbackSentiment',
                type: 'stackedBar',
                title: 'Platform feedback by sentiment',
                series: seriesFromRows(feedbackSplit.current, f => f.createdAt, period, {
                    positive: f => (f.sentiment === 'POSITIVE' ? 1 : 0),
                    neutral: f => (f.sentiment === 'NEUTRAL' ? 1 : 0),
                    negative: f => (f.sentiment === 'NEGATIVE' ? 1 : 0),
                    severe: f => (f.sentiment === 'SEVERE_NEGATIVE' ? 1 : 0)
                })
            },
            { key: 'feedbackByArea', type: 'table', title: 'Feedback by area', rows: this._feedbackByArea(feedbackSplit.current) }
        ];

        return {
            tiles,
            charts,
            dataNotes: [
                'Tickets are counted on the day they were raised.',
                'Acknowledgement is the first claim or move out of New/Triage. First reply is recorded when an agent claims the ticket.'
            ]
        };
    }



    _ticketTrend(tickets, period) {
        const raised = seriesFromRows(tickets, t => t.createdAt, period, { raised: () => 1 });
        const closed = seriesFromRows(tickets.filter(t => closedAt(t)), t => closedAt(t), period, { closed: () => 1 });
        return raised.map((row, i) => ({ ...row, closed: closed[i].closed }));
    }



    _backlogAge(backlog) {
        const now = Date.now();
        const bands = BACKLOG_AGE_BANDS.map(b => ({ ...b, count: 0 }));
        for (const t of backlog) {
            const age = (now - new Date(t.createdAt)) / DAY_MS;
            (bands.find(b => age < b.max) || bands[bands.length - 1]).count++;
        }
        return bands.map(({ max, ...rest }) => rest);
    }



    async _workload(tickets) {
        const counts = countBy(tickets.filter(t => t.assignedTo && closedAt(t)), t => t.assignedTo.toString(), 15);
        const admins = await User.find({ _id: { $in: counts.map(c => c.key) } }).select('name').lean();
        const nameById = new Map(admins.map(a => [a._id.toString(), a.name]));
        return counts.map(({ key, count }) => ({ adminId: key, name: nameById.get(key) || '—', closed: count }));
    }



    _feedbackByArea(feedback) {
        return countBy(feedback, f => f.area).map(({ key, count }) => {
            const list = feedback.filter(f => f.area === key);
            return {
                area: key,
                count,
                negativeShare: ratio(list.filter(f => ['NEGATIVE', 'SEVERE_NEGATIVE'].includes(f.sentiment)).length, list.length),
                convertedToTicket: list.filter(f => f.convertedToTicket).length
            };
        });
    }
}

module.exports = new SupportAnalytics();
