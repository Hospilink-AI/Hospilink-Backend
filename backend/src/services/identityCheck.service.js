const crypto = require('crypto');
const mongoose = require('mongoose');
const IdentityCheck = require('../models/IdentityCheck');
const Document = require('../models/Document');
const MedicalStaff = require('../models/MedicalStaff');
const Hospital = require('../models/Hospital');
const User = require('../models/User');
const logger = require('../utils/logger');
const {
    compareNames,
    compareCompanyNames,
    compareDobs,
    compareNumbers,
    normalizeNumber,
    isPersonalPan
} = require('../utils/identityMatch');

/**
 * Do the details on a user's identity documents agree with each other and
 * with their profile?
 *
 * Doctors and nurses: the profile name against the name on the Aadhaar, PAN,
 * licence and council certificate; the date of birth across Aadhaar, PAN and
 * the certificate (the profile has none); the licence number against the
 * certificate's registration number; and the PAN against other accounts.
 * Hospitals: the Aadhaar and personal PAN of the person signing up (name and
 * date of birth), and the company names on GST, CIN and the profile.
 *
 * A value that can't be read never counts as a difference. Differences are
 * stored in IdentityCheck for admins only. For serious ones (a different name
 * or date of birth, a PAN on another account) the user gets a reminder to
 * check their details, now and on days 3 and 7, without being told about
 * the flag.
 */

const NOTICE_TYPE = 'IDENTITY_DETAILS_MISMATCH';
const REMINDER_DAYS = [0, 3, 7];
const MAX_VALUE_LENGTH = 100;

const LABEL = {
    profile: 'Profile',
    'aadhaar-card': 'Aadhaar',
    'pan-card': 'PAN',
    'license-permit': 'Licence',
    'mcim-certificate': 'MCIM certificate',
    'ncim-certificate': 'NCIM certificate',
    'gst-certificate': 'GST certificate',
    'cin-certificate': 'CIN certificate'
};

const MESSAGES = {
    staff: 'Some details on your documents don\'t match your profile. Make sure the name in your profile is exactly as on your Aadhaar, PAN, licence and registration certificate, and that every document is yours and clearly readable.',
    hospital: 'Some details on your hospital\'s documents don\'t match. Check that the Aadhaar and PAN belong to the same person, and that the GST and CIN certificates are for your hospital\'s company.'
};

const first = (...values) => values.find(v => typeof v === 'string' && v.trim()) || null;
const clip = (value) => (value == null ? null : String(value).slice(0, MAX_VALUE_LENGTH));
const maskPan = (pan) => (pan ? `*****${normalizeNumber(pan).slice(5)}` : null);

// The fields each document type gives, whatever the source (OCR or IDfy)
function readDocument(entry) {
    const data = entry.extractedData || {};
    switch (entry.documentType) {
        case 'aadhaar-card':
            return {
                name: first(data.name, data.full_name, data.fullName, data.name_on_card, data.nameOnCard),
                dob: first(data.dob, data.date_of_birth, data.dateOfBirth,
                    data.year_of_birth != null ? String(data.year_of_birth) : null,
                    data.yob != null ? String(data.yob) : null)
            };
        case 'pan-card':
            return { name: first(data.name, data.name_on_card), dob: first(data.dob), panNumber: first(data.panNumber, data.id_number) };
        case 'license-permit':
            return { name: first(data.name), number: first(data.licenseNumber) };
        case 'mcim-certificate':
        case 'ncim-certificate':
            return { name: first(data.doctorName, data.name), dob: first(data.dob), number: first(data.registrationNumber) };
        case 'gst-certificate':
            return { legalName: first(data.legalName), tradeName: first(data.tradeName) };
        case 'cin-certificate':
            return { companyName: first(data.businessName) };
        default:
            return {};
    }
}

// The newest document of each type that hasn't been deleted or rejected
function currentDocuments(record) {
    const byType = {};
    for (const entry of record?.documents || []) {
        if (entry.isDeleted || entry.verificationStatus === 'rejected') continue;
        const previous = byType[entry.documentType];
        if (!previous || new Date(entry.uploadedAt || 0) >= new Date(previous.uploadedAt || 0)) {
            byType[entry.documentType] = entry;
        }
    }
    const read = {};
    for (const [type, entry] of Object.entries(byType)) read[type] = readDocument(entry);
    return read;
}

class Findings {
    constructor() {
        this.issues = [];
        this.comparisons = [];
    }

    name(source, sourceValue, against, againstValue) {
        if (!sourceValue || !againstValue) return 'unknown';
        const result = compareNames(sourceValue, againstValue);
        this.comparisons.push({ field: 'name', source, against, result });
        if (result === 'mismatch') this.add('NAME_MISMATCH', 'high', 'name', source, sourceValue, against, againstValue);
        if (result === 'partial') this.add('NAME_PARTIAL', 'low', 'name', source, sourceValue, against, againstValue);
        return result;
    }

    dob(source, sourceValue, against, againstValue) {
        if (!sourceValue || !againstValue) return 'unknown';
        const result = compareDobs(sourceValue, againstValue);
        this.comparisons.push({ field: 'dob', source, against, result });
        if (result === 'mismatch') this.add('DOB_MISMATCH', 'high', 'dob', source, sourceValue, against, againstValue);
        return result;
    }

    number(source, sourceValue, against, againstValue) {
        if (!sourceValue || !againstValue) return 'unknown';
        const result = compareNumbers(sourceValue, againstValue);
        this.comparisons.push({ field: 'registrationNumber', source, against, result });
        if (result === 'mismatch') this.add('NUMBER_MISMATCH', 'low', 'registrationNumber', source, sourceValue, against, againstValue);
        return result;
    }

    company(source, sourceValue, against, againstValue) {
        if (!sourceValue || !againstValue) return 'unknown';
        const result = compareCompanyNames(sourceValue, againstValue);
        this.comparisons.push({ field: 'companyName', source, against, result });
        return result;
    }

    add(code, severity, field, source, sourceValue, against, againstValue, extra = {}) {
        this.issues.push({
            code, severity, field, source, against,
            sourceValue: clip(sourceValue), againstValue: clip(againstValue), ...extra
        });
    }
}

async function findDuplicatePan(userId, role, pan) {
    const number = normalizeNumber(pan);
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(number)) return null;
    const other = await Document.findOne({
        userId: { $ne: userId },
        userRole: role,
        'documents.extractedData.panNumber': number,
        documents: {
            $elemMatch: { documentType: 'pan-card', isDeleted: { $ne: true }, 'extractedData.panNumber': number }
        }
    }).select('userId').lean();
    return other?.userId || null;
}

async function staffFindings(userId, docs) {
    const findings = new Findings();
    const profile = await MedicalStaff.findOne({ user: userId }).select('fullName').lean();
    const profileName = profile?.fullName;

    for (const type of ['aadhaar-card', 'pan-card', 'license-permit', 'mcim-certificate', 'ncim-certificate']) {
        if (docs[type]) findings.name('profile', profileName, type, docs[type].name);
    }

    const dobSources = ['aadhaar-card', 'pan-card', 'mcim-certificate', 'ncim-certificate'].filter(t => docs[t]?.dob);
    for (let i = 0; i < dobSources.length; i++) {
        for (let j = i + 1; j < dobSources.length; j++) {
            findings.dob(dobSources[i], docs[dobSources[i]].dob, dobSources[j], docs[dobSources[j]].dob);
        }
    }

    const certificate = docs['mcim-certificate'] || docs['ncim-certificate'];
    const certificateType = docs['mcim-certificate'] ? 'mcim-certificate' : 'ncim-certificate';
    if (docs['license-permit'] && certificate) {
        findings.number('license-permit', docs['license-permit'].number, certificateType, certificate.number);
    }

    const pan = docs['pan-card']?.panNumber;
    if (pan) {
        const otherUserId = await findDuplicatePan(userId, 'staff', pan);
        if (otherUserId) {
            findings.add('DUPLICATE_PAN', 'high', 'panNumber', 'pan-card', maskPan(pan), 'another account', null, { otherUserId });
        }
    }
    return findings;
}

async function hospitalFindings(userId, docs) {
    const findings = new Findings();
    const profile = await Hospital.findOne({ user: userId }).select('hospitalLegalName').lean();

    // The person signing up: their Aadhaar and their own PAN
    const pan = docs['pan-card'];
    if (docs['aadhaar-card'] && pan && isPersonalPan(pan.panNumber)) {
        findings.name('aadhaar-card', docs['aadhaar-card'].name, 'pan-card', pan.name);
        findings.dob('aadhaar-card', docs['aadhaar-card'].dob, 'pan-card', pan.dob);
    }

    // The company: GST and CIN should name the same one
    const gst = docs['gst-certificate'];
    const cin = docs['cin-certificate'];
    if (gst && cin && findings.company('gst-certificate', gst.legalName, 'cin-certificate', cin.companyName) === 'mismatch') {
        findings.add('COMPANY_NAME_MISMATCH', 'low', 'companyName', 'gst-certificate', gst.legalName, 'cin-certificate', cin.companyName);
    }

    // The hospital's name should be its legal or trade name
    const hospitalName = profile?.hospitalLegalName;
    const registered = [
        ['gst-certificate', gst?.legalName], ['gst-certificate', gst?.tradeName], ['cin-certificate', cin?.companyName]
    ].filter(([, value]) => value);
    if (hospitalName && registered.length) {
        const results = registered.map(([type, value]) => findings.company('profile', hospitalName, type, value));
        if (results.every(r => r === 'mismatch')) {
            findings.add('COMPANY_NAME_MISMATCH', 'low', 'companyName', 'profile', hospitalName, registered[0][0], registered[0][1]);
        }
    }
    return findings;
}

function fingerprintOf(issues) {
    const key = issues
        .map(i => [i.code, i.source, i.against, i.sourceValue, i.againstValue].join('|'))
        .sort()
        .join('\n');
    return crypto.createHash('sha1').update(key).digest('hex');
}

async function notify(userId, role) {
    const notificationService = require('./notificationService');
    const notificationDelivery = require('./notificationDelivery.service');
    const payload = {
        type: NOTICE_TYPE,
        message: MESSAGES[role] || MESSAGES.staff,
        timestamp: new Date().toISOString()
    };
    const { unreadCount } = await notificationService.createNotificationWithCount(String(userId), NOTICE_TYPE, payload);
    await notificationDelivery.deliverToUser(String(userId), NOTICE_TYPE, payload, unreadCount);
}

/**
 * Compare the user's current documents and profile and store the result.
 * A new serious difference sends the first reminder at once.
 * @returns {Promise<Object|null>} the stored IdentityCheck, or null for other roles
 */
async function evaluate(userId) {
    const id = new mongoose.Types.ObjectId(String(userId));
    const user = await User.findById(id).select('role').lean();
    if (!user || !['staff', 'hospital'].includes(user.role)) return null;

    const record = await Document.findOne({ userId: id })
        .select('documents.documentType documents.isDeleted documents.verificationStatus documents.uploadedAt documents.extractedData')
        .lean();
    const docs = currentDocuments(record);
    const findings = user.role === 'staff' ? await staffFindings(id, docs) : await hospitalFindings(id, docs);
    const { issues, comparisons } = findings;

    const previous = await IdentityCheck.findOne({ user: id }).lean();
    const now = new Date();
    const severity = issues.some(i => i.severity === 'high') ? 'high' : (issues.length ? 'low' : null);
    const fingerprint = issues.length ? fingerprintOf(issues) : null;

    let status = 'clear';
    if (issues.length) status = previous?.dismissed?.fingerprint === fingerprint ? 'dismissed' : 'flagged';
    const sameFlag = status === 'flagged' && previous?.status === 'flagged' && previous.fingerprint === fingerprint;
    const sendNow = status === 'flagged' && severity === 'high' && !sameFlag;

    const update = {
        role: user.role,
        status,
        severity,
        issues,
        comparisons,
        fingerprint,
        checkedAt: now,
        flaggedAt: status === 'flagged' ? (sameFlag ? previous.flaggedAt : now) : (status === 'dismissed' ? previous.flaggedAt : null),
        reminders: sameFlag ? previous.reminders : { count: sendNow ? 1 : 0, lastSentAt: sendNow ? now : null }
    };
    const saved = await IdentityCheck.findOneAndUpdate(
        { user: id },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true, lean: true }
    );

    if (sendNow) {
        await notify(id, user.role).catch(err => logger.warn(`Identity reminder not sent: ${err.message}`));
    }
    if (status === 'flagged' && !sameFlag) {
        logger.info(`Identity details flagged: user=${id} severity=${severity} issues=${issues.map(i => i.code).join(',')}`);
    }
    return saved;
}

// Re-check after a document or profile change, without holding up the request
function checkSoon(userId) {
    if (!userId) return;
    setImmediate(() => {
        evaluate(userId).catch(err => logger.warn(`Identity check failed for user ${userId}: ${err.message}`));
    });
}

/**
 * Should an Aadhaar that DigiLocker returned be verified automatically?
 * Doctors: the DigiLocker name must match the profile name, and the date of
 * birth must not differ from their PAN or certificate. Hospitals: it must
 * not differ from the person's own PAN.
 * @returns {Promise<{autoVerify: boolean, reason: string|null}>}
 */
async function aadhaarDecision(userId, role, details) {
    const aadhaar = readDocument({ documentType: 'aadhaar-card', extractedData: details || {} });
    const id = new mongoose.Types.ObjectId(String(userId));
    const record = await Document.findOne({ userId: id })
        .select('documents.documentType documents.isDeleted documents.verificationStatus documents.uploadedAt documents.extractedData')
        .lean();
    const docs = currentDocuments(record);

    if (role === 'staff') {
        const profile = await MedicalStaff.findOne({ user: id }).select('fullName').lean();
        const name = compareNames(profile?.fullName, aadhaar.name);
        if (name !== 'match') return { autoVerify: false, reason: name === 'unknown' ? 'name_unreadable' : `name_${name}` };
        for (const type of ['pan-card', 'mcim-certificate', 'ncim-certificate']) {
            if (docs[type]?.dob && compareDobs(aadhaar.dob, docs[type].dob) === 'mismatch') {
                return { autoVerify: false, reason: 'dob_mismatch' };
            }
        }
        return { autoVerify: true, reason: null };
    }

    const pan = docs['pan-card'];
    if (pan && isPersonalPan(pan.panNumber)) {
        const name = compareNames(aadhaar.name, pan.name);
        if (name === 'mismatch' || name === 'partial') return { autoVerify: false, reason: `name_${name}` };
        if (compareDobs(aadhaar.dob, pan.dob) === 'mismatch') return { autoVerify: false, reason: 'dob_mismatch' };
    }
    return { autoVerify: true, reason: null };
}

/**
 * Should a PAN that IDfy found be verified automatically? For doctors the
 * name read from the card must match the profile name.
 */
async function panDecision(userId, role, panName) {
    if (role !== 'staff') return { autoVerify: true, reason: null };
    const profile = await MedicalStaff.findOne({ user: new mongoose.Types.ObjectId(String(userId)) }).select('fullName').lean();
    const name = compareNames(profile?.fullName, panName);
    if (name === 'match') return { autoVerify: true, reason: null };
    return { autoVerify: false, reason: name === 'unknown' ? 'name_unreadable' : `name_${name}` };
}

/**
 * Reminders on days 3 and 7 for serious flags still open. Run once a day.
 * @returns {Promise<number>} reminders sent
 */
async function sendDueReminders(now = new Date()) {
    let sent = 0;
    for (let step = 1; step < REMINDER_DAYS.length; step++) {
        const dueBefore = new Date(now.getTime() - REMINDER_DAYS[step] * 24 * 60 * 60 * 1000);
        const due = await IdentityCheck.find({
            status: 'flagged',
            severity: 'high',
            flaggedAt: { $lte: dueBefore },
            'reminders.count': step
        }).select('user role').limit(500).lean();
        for (const check of due) {
            const claimed = await IdentityCheck.updateOne(
                { _id: check._id, status: 'flagged', 'reminders.count': step },
                { $set: { 'reminders.count': step + 1, 'reminders.lastSentAt': now } }
            );
            if (!claimed.modifiedCount) continue;
            await notify(check.user, check.role).catch(err => logger.warn(`Identity reminder not sent: ${err.message}`));
            sent++;
        }
    }
    return sent;
}

// ── Admin ───────────────────────────────────────────────────────────────────

const summarize = (check) => (check ? {
    status: check.status,
    severity: check.severity,
    issueCount: (check.issues || []).length,
    checkedAt: check.checkedAt
} : null);

// { userId: summary } for a page of admin list rows
async function summariesFor(userIds) {
    const ids = [...new Set((userIds || []).filter(Boolean).map(String))]
        .filter(id => mongoose.Types.ObjectId.isValid(id));
    if (!ids.length) return {};
    const checks = await IdentityCheck.find({ user: { $in: ids } })
        .select('user status severity issues.code checkedAt')
        .lean();
    return Object.fromEntries(checks.map(check => [String(check.user), summarize(check)]));
}

const rowUserId = (row) => String(row?.userId || row?.user?.id || row?.user?._id || row?.user || '');

// Adds `identityCheck` (summary) to each admin list row
async function attachSummaries(rows) {
    if (!Array.isArray(rows) || !rows.length) return rows;
    const summaries = await summariesFor(rows.map(rowUserId));
    for (const row of rows) row.identityCheck = summaries[rowUserId(row)] || null;
    return rows;
}

const describeIssue = (issue) => ({
    ...issue,
    sourceLabel: LABEL[issue.source] || issue.source,
    againstLabel: LABEL[issue.against] || issue.against
});

// The full record for an admin; checked now if it never has been
async function forAdmin(userId) {
    if (!mongoose.Types.ObjectId.isValid(String(userId))) return null;
    let check = await IdentityCheck.findOne({ user: userId }).lean();
    if (!check) check = await evaluate(userId);
    if (!check) return null;
    return {
        status: check.status,
        severity: check.severity,
        issues: (check.issues || []).map(describeIssue),
        comparisons: check.comparisons || [],
        checkedAt: check.checkedAt,
        flaggedAt: check.flaggedAt,
        dismissed: check.dismissed?.at ? check.dismissed : null,
        remindersSent: check.reminders?.count || 0
    };
}

async function list({ status = 'flagged', severity, role, page = 1, limit = 20 } = {}) {
    const filter = {};
    if (status) filter.status = status;
    if (severity) filter.severity = severity;
    if (role) filter.role = role;
    const skip = (Math.max(1, page) - 1) * limit;
    const [rows, total] = await Promise.all([
        IdentityCheck.find(filter).sort({ flaggedAt: -1, checkedAt: -1 }).skip(skip).limit(limit)
            .populate('user', 'name email role').lean(),
        IdentityCheck.countDocuments(filter)
    ]);
    return {
        items: rows.map(row => ({
            userId: row.user?._id || row.user,
            name: row.user?.name || null,
            email: row.user?.email || null,
            role: row.role,
            status: row.status,
            severity: row.severity,
            issues: (row.issues || []).map(describeIssue),
            flaggedAt: row.flaggedAt,
            checkedAt: row.checkedAt,
            remindersSent: row.reminders?.count || 0
        })),
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) }
    };
}

/**
 * An admin accepts the current differences (say, a name changed after
 * marriage). Reminders stop. A new difference flags the account again.
 */
async function dismiss(userId, adminId, note) {
    const check = await IdentityCheck.findOne({ user: userId }).lean();
    if (!check || check.status !== 'flagged') return null;
    return IdentityCheck.findOneAndUpdate(
        { _id: check._id },
        {
            $set: {
                status: 'dismissed',
                dismissed: { by: adminId, at: new Date(), note: note ? String(note).slice(0, 500) : null, fingerprint: check.fingerprint }
            }
        },
        { new: true, lean: true }
    );
}

module.exports = {
    NOTICE_TYPE,
    REMINDER_DAYS,
    readDocument,
    currentDocuments,
    evaluate,
    checkSoon,
    aadhaarDecision,
    panDecision,
    sendDueReminders,
    summariesFor,
    attachSummaries,
    forAdmin,
    list,
    dismiss
};
