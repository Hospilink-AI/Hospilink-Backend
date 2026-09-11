const { GoogleGenerativeAI } = require('@google/generative-ai');
const { z } = require('zod');
const { CATEGORIES } = require('../utils/ticket.constants');
const { t } = require('../utils/botCopy');
const knowledgeBaseService = require('./knowledgeBase.service');
const logger = require('../utils/logger');

// Same fallback-list/lazy-client pattern as resumeParsing.service.js.
const MODELS = [process.env.GEMINI_MODEL || process.env.GEMINI_MODEL_FALLBACK];

let genAI = null;
function getClient() {
    if (!genAI) {
        genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    }
    return genAI;
}

// One line per category, in plain language — what the classifier reasons
// against instead of the bare enum value. Duty-linked categories are the
// ones Phase 1 actually asks a follow-up "which duty?" question for (see
// DUTY_LINKED_CATEGORIES below); the rest classify fine from text alone.
const CATEGORY_HINTS = {
    'duty.end_otp_unverified': 'A shift the staff member worked but couldn\'t end because the hospital never gave/confirmed the end OTP.',
    'duty.start_otp_failure': 'The start OTP for a shift didn\'t work, was never given, or the staff member got locked out trying to start.',
    'duty.no_show_staff': 'The staff member who was assigned a shift never showed up for it.',
    'duty.no_show_hospital': 'The hospital had no one there / wasn\'t ready when the staff member arrived for a confirmed shift.',
    'duty.late_arrival': 'The staff member arrived late to a shift.',
    'duty.early_departure': 'The staff member left a shift before it was scheduled to end.',
    'duty.cancellation_staff': 'The staff member cancelled a shift they had accepted.',
    'duty.cancellation_hospital': 'The hospital cancelled a shift after it had been assigned/confirmed.',
    'duty.details_mismatch': 'The actual shift (location, role, timing, ward) didn\'t match what was posted or agreed.',
    'duty.status_change_request': 'Asking for a shift\'s recorded status to be corrected (e.g. it shows cancelled but was actually completed).',
    'duty.details_change_request': 'Asking for a shift\'s recorded details (time, location, role) to be corrected.',
    'duty.work_quality': 'A complaint about the quality/standard of clinical work performed during a shift.',
    'duty.working_conditions': 'A complaint about the conditions at the workplace during a shift (safety, equipment, staffing levels, hygiene).',
    'duty.scope_of_practice': 'Concern that a staff member was asked to do something outside what their role/qualification permits.',
    'duty.conduct_staff': 'A complaint about a staff member\'s behaviour/conduct during a shift.',
    'duty.conduct_hospital': 'A complaint about hospital staff/management\'s behaviour toward the platform worker during a shift.',
    'duty.credential_challenge': 'A dispute over whether a staff member actually holds the qualification/credential they claimed for a shift.',
    'payment.non_payment': 'Payment for a completed shift was never received at all.',
    'payment.amount_mismatch': 'The amount paid for a shift doesn\'t match what was agreed/expected.',
    'payment.overtime_unpaid': 'Extra time worked beyond the scheduled shift wasn\'t paid for.',
    'payment.deduction_disputed': 'A deduction was made from a payment that the person disputes.',
    'payment.mode_dispute': 'A disagreement about how a payment was made (cash vs. UPI vs. bank, etc.) or how it should be made.',
    'payment.refund_request': 'Asking for money to be refunded (e.g. a hospital that pre-paid for a shift that didn\'t happen as planned).',
    'safety.patient_incident': 'A patient safety incident that happened during a shift.',
    'safety.staff_incident': 'A safety incident that happened TO the staff member during a shift (injury, unsafe conditions, assault).',
    'safety.harassment': 'Harassment of any kind — by a patient, hospital staff, or a platform worker.',
    'jobs.application_revoke': 'Asking to withdraw/cancel a job application that was already submitted.',
    'jobs.interview_reschedule': 'Asking to change the date/time of a scheduled interview.',
    'jobs.interview_cancellation': 'Asking to cancel a scheduled interview entirely.',
    'jobs.interview_no_show': 'The other side (candidate or hospital) didn\'t show up for a scheduled interview.',
    'jobs.ai_score_challenge': 'Disputing the AI-generated match/fit score given on a job application.',
    'jobs.parsed_data_incorrect': 'The information auto-extracted from a resume/profile is wrong.',
    'jobs.listing_misleading': 'A job vacancy listing didn\'t match reality (pay, role, location, requirements).',
    'jobs.offer_reneged': 'A job offer was withdrawn or not honoured after being extended/accepted.',
    'account.verification_delay': 'Account/document verification is taking too long.',
    'account.verification_rejected': 'An account or document was rejected during verification and the person disagrees.',
    'account.rating_challenge': 'Disputing a rating/review received on the platform.',
    'account.suspension_appeal': 'Appealing an account suspension.',
    'account.access_locked': 'Locked out of the account and can\'t get back in.',
    'account.impersonation_report': 'Reporting that someone else is impersonating them or using their identity on the platform.',
    'account.closure_request': 'Asking for their account to be closed/deleted.',
    'platform.app_fault': 'Something in the app itself is broken, crashing, or not working as it should.',
    'platform.notification_failure': 'Notifications/alerts that should have arrived never came through.',
    'platform.location_issue': 'A problem with location/GPS/map features in the app.',
    'platform.data_incorrect': 'Information shown in the app about them (other than resume-parsed fields) is wrong.',
    'platform.feedback': 'General feedback or a suggestion about the platform, not a specific problem needing a fix.',
    'data.access_request': 'Asking for a copy of the personal data the platform holds about them.',
    'data.correction_request': 'Asking for incorrect personal data to be corrected (a formal data-rights request, distinct from a routine profile-field fix).',
    'data.erasure_request': 'Asking for their personal data to be deleted.',
    'data.consent_withdrawal': 'Withdrawing consent previously given for some use of their data.',
    'data.breach_concern': 'Reporting a concern that their data may have been exposed/breached.'
};

// Phase 1 only builds a subject-linking follow-up ("which shift is this
// about?") for duty-shaped categories — the ones duty.service.js already
// has ready-made list methods for. Application/interview/vacancy pickers
// are a later pass; those categories still classify and create tickets
// fine, just without a guided subject-linking step this phase.
const DUTY_LINKED_CATEGORIES = new Set([
    ...CATEGORIES.filter(c => c.startsWith('duty.')),
    ...CATEGORIES.filter(c => c.startsWith('payment.')),
    ...CATEGORIES.filter(c => c.startsWith('safety.'))
]);

// Short, hand-written context so an informational question doesn't get
// misfiled into a spurious ticket. Not a real knowledge base (Phase 4).
const PLATFORM_CONTEXT = `HospiLink connects hospitals with medical staff for shift-based work, and separately runs a job-application/hiring flow. Staff accept shifts ("duties"), start/end them with an OTP the hospital confirms, and get paid per shift. Disputes about a shift, a payment, an interview, a job application, the app itself, or someone's account/data can all become a support ticket. Purely informational questions — "how do I withdraw my application", "how does the OTP work", "what happens if I'm late" — should usually be answered directly without creating a ticket, unless something has actually already gone wrong for this specific person.`;

const IntentResponseSchema = z.object({
    intent: z.enum(['TICKET', 'INFORMATIONAL', 'UNCLEAR']).catch('UNCLEAR'),
    category: z.enum(CATEGORIES).nullable().catch(null),
    confidence: z.coerce.number().min(0).max(1).catch(0),
    reply: z.string().catch("Sorry, could you tell me a bit more about what's going on?"),
    buttons: z.array(z.string()).catch([])
});

// Chatbot intake Phase 3 — the classifier is the one place dynamic bot text
// gets generated, so it's also where language actually gets produced:
// Gemini writes "reply" directly in the target language rather than this
// service pre-translating anything. CATEGORY_HINTS/PLATFORM_CONTEXT stay
// English-only — an LLM reasons over English reference material and writes
// Hindi/Marathi output natively, no separate translation step needed.
const LANGUAGE_NAMES = { en: 'English', hi: 'Hindi', mr: 'Marathi' };

// Chatbot intake Phase 4 — real FAQ content (admin-managed via
// knowledgeBase.service.js) appended after the short scene-setting
// paragraph above. Falls back to PLATFORM_CONTEXT alone when the
// collection is empty (unseeded environment) — never regresses to zero
// context. English-only, same reasoning as CATEGORY_HINTS: Gemini reasons
// over English reference material and still writes its reply in the
// target language (wired in Phase 3).
function buildKnowledgeBaseBlock(articles) {
    if (!articles || articles.length === 0) return '';
    const entries = articles.map(a => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n');
    return `\n\nKnown platform FAQ (use these directly when they answer the user's question):\n${entries}`;
}

function buildPrompt({ history, message, language, knowledgeBaseArticles }) {
    const languageName = LANGUAGE_NAMES[language] || 'English';
    const categoryList = CATEGORIES.map(c => `- ${c}: ${CATEGORY_HINTS[c]}`).join('\n');
    const historyText = (history || [])
        .map(m => `${m.sender === 'user' ? 'User' : 'Bot'}: ${m.selectedButton || m.text || ''}`)
        .join('\n');

    return `You are HospiLink's support intake assistant, reading one message in an ongoing conversation with a ${languageName}-speaking platform user (a medical staff member or a hospital) who may be raising a problem or just asking a question.

${PLATFORM_CONTEXT}${buildKnowledgeBaseBlock(knowledgeBaseArticles)}

Conversation so far:
${historyText || '(nothing yet)'}

Latest user message:
"""
${message}
"""

Decide ONE of three intents:
- "TICKET" — this describes a real problem that matches one of the categories below. Pick the single best-matching category and a confidence 0-1 for how sure you are.
- "INFORMATIONAL" — this is a question answerable directly from the context above, with nothing that's actually gone wrong for this person. Answer it directly and helpfully in "reply" — do not set "category".
- "UNCLEAR" — not enough information yet to tell. Ask ONE short, specific clarifying question in "reply" — do not set "category" or guess one.

Categories (English reference only — classify against these regardless of what language the user wrote in):
${categoryList}

Return STRICT JSON only, matching exactly this shape:
{
  "intent": "TICKET" | "INFORMATIONAL" | "UNCLEAR",
  "category": one of the exact category keys above, or null,
  "confidence": number 0-1 (only meaningful when intent is "TICKET" — how confident you are in that exact category, not just that it's ticket-worthy),
  "reply": string — what the bot should say next, written ENTIRELY IN ${languageName} regardless of what language this prompt itself is written in. For "TICKET": one short sentence plainly describing the problem you understood, ending in a question asking the user to confirm it's right (e.g. "It sounds like your payment for a shift never came through — is that right?"). For "INFORMATIONAL": the direct answer. For "UNCLEAR": one short clarifying question. English technical terms (e.g. "OTP", "UPI") staying as-is inside an otherwise-${languageName} sentence is normal, everyday usage in India — not an error.,
  "buttons": array of strings — for "TICKET" always exactly the ${languageName}-language equivalent of ["Yes, that's right", "No, let me pick"]; otherwise an empty array. (Note: the calling application actually supplies its own fixed button text and ignores this field — fill it in anyway for consistency.)
}`;
}

class TicketIntentClassifierService {
    async classify({ history, message, language = 'en' }) {
        if (!process.env.GEMINI_API_KEY) {
            logger.warn('ticketIntentClassifier.service: GEMINI_API_KEY not configured — returning UNCLEAR fallback');
            return {
                intent: 'UNCLEAR', category: null, confidence: 0,
                reply: t('classifierNoKeyFallback', language), buttons: []
            };
        }

        // Never let a knowledge-base read failure block classification —
        // same "context is a convenience, not a correctness requirement"
        // reasoning ticket.service.js already applies to linkedContext.
        let knowledgeBaseArticles = [];
        try {
            knowledgeBaseArticles = await knowledgeBaseService.listActive();
        } catch (err) {
            logger.warn(`ticketIntentClassifier.service: knowledge base fetch failed, continuing without it: ${err.message}`);
        }

        const client = getClient();
        const prompt = buildPrompt({ history, message, language, knowledgeBaseArticles });

        for (const modelName of MODELS) {
            try {
                const model = client.getGenerativeModel({
                    model: modelName,
                    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
                });
                const result = await model.generateContent(prompt);
                const raw = JSON.parse(result.response.text());
                return IntentResponseSchema.parse(raw);
            } catch (err) {
                logger.warn(`ticketIntentClassifier.service: model "${modelName}" failed: ${err.message}`);
            }
        }

        logger.error('ticketIntentClassifier.service: all models failed — returning UNCLEAR fallback');
        return {
            intent: 'UNCLEAR', category: null, confidence: 0,
            reply: t('classifierAllModelsFailedFallback', language), buttons: []
        };
    }

    isDutyLinked(category) {
        return DUTY_LINKED_CATEGORIES.has(category);
    }
}

module.exports = new TicketIntentClassifierService();
