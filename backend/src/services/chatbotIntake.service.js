const TicketConversation = require('../models/TicketConversation');
const Duty = require('../models/Duty');
const MedicalStaff = require('../models/MedicalStaff');
const Hospital = require('../models/Hospital');
const dutyService = require('./duty.service');
const ticketService = require('./ticket.service');
const ticketCategoryConfigService = require('./ticketCategoryConfig.service');
const ticketIntentClassifier = require('./ticketIntentClassifier.service');
const systemConfigService = require('./systemConfig.service');
const websocketManager = require('./websocketManager');
const { t } = require('../utils/botCopy');
const { DOMAINS } = require('../utils/ticket.constants');

const MAX_CLARIFY_TURNS = 3;

// Phase 5 — domain -> botCopy key, in ticket.constants.js's own DOMAINS
// order, so the quick-reply set is always the real taxonomy, never a
// separately hand-picked subset that could drift from it.
const DOMAIN_COPY_KEYS = {
    duty: 'domainDuty', payment: 'domainPayment', safety: 'domainSafety', jobs: 'domainJobs',
    account: 'domainAccount', platform: 'domainPlatform', data: 'domainData'
};

// Every ticket-creating branch ends the same way: ask about evidence.
// Detected on the next turn by checking conversation.ticket is already set
// (a real, persisted field) rather than staging state across requests.
// evidenceRequired (Phase 2 — per-category, from ticketCategoryConfig) makes
// the ask specific when the category has one; falls back to the original
// generic wording for categories that legitimately don't (requests/
// housekeeping rather than disputes needing proof). Evidence item names
// stay in English regardless of language — see botCopy.js's header comment.
function evidenceAskText(ticket, evidenceRequired, language) {
    const base = t('evidenceAskBase', language, { ticketId: ticket.ticketId });
    if (evidenceRequired && evidenceRequired.length > 0) {
        return `${base} ${t('evidenceAskSpecific', language, { items: evidenceRequired.join(', ') })}`;
    }
    return `${base} ${t('evidenceAskGeneric', language)}`;
}

class ChatbotIntakeService {
    async getActiveConversation(user) {
        const userId = user._id || user.id;
        return TicketConversation.findOne({ user: userId, status: 'active' }).sort({ updatedAt: -1 }).lean();
    }

    _lastBotMessage(conversation) {
        for (let i = conversation.messages.length - 1; i >= 0; i--) {
            if (conversation.messages[i].sender === 'bot') return conversation.messages[i];
        }
        return null;
    }

    // A tapped chip is just a pre-written message — it flows through the
    // same _handleFreshMessage -> classify() path as free text, no new step.
    _domainQuickReplies(language) {
        return [...DOMAINS.map(d => t(DOMAIN_COPY_KEYS[d], language)), t('domainOther', language)];
    }

    _sameButtons(a, b) {
        return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
    }

    // Step is derived from the conversation's own persisted state each
    // turn — the last bot turn's buttons/text, plus whether a ticket has
    // already been created — rather than a dedicated "step" column that
    // would just duplicate what's already there.
    _deriveStep(conversation) {
        if (conversation.ticket) return 'AWAITING_EVIDENCE';
        const last = this._lastBotMessage(conversation);
        if (!last) return 'FRESH';
        const language = conversation.language;
        if (this._sameButtons(last.buttons, [t('confirmYes', language), t('confirmNo', language)])) return 'AWAITING_CONFIRMATION';
        if (last.text === t('subjectLinkPrompt', language)) return 'AWAITING_SUBJECT';
        return 'FRESH';
    }

    async _dutyOptionsFor(user, language) {
        const userId = user._id || user.id;
        if (user.role === 'staff') {
            const result = await dutyService.getCompletedDutiesForStaff(userId, 1, 5);
            return (result.duties || []).map(d => ({
                id: d._id.toString(),
                label: t('dutyOptionForStaff', language, {
                    role: d.staffRole || t('shiftFallback', language),
                    hospital: d.hospital?.hospitalLegalName || t('hospitalFallback', language),
                    date: new Date(d.date).toLocaleDateString('en-IN')
                })
            }));
        }
        const result = await dutyService.getDutyHistory({ hospitalUserId: userId, page: 1, limit: 5 });
        return (result.duties || []).map(d => ({
            id: d.dutyId.toString(),
            label: t('dutyOptionForHospital', language, {
                role: d.staffRole || t('shiftFallback', language),
                staffName: d.staff?.name || t('staffFallback', language),
                date: new Date(d.date).toLocaleDateString('en-IN')
            })
        }));
    }

    // A DUTY_LINKED, ADJUDICATED ticket needs the other party (spec:
    // two-person disputes need both sides) — resolved from the picked duty
    // itself rather than asked for separately, since we already have it.
    async _resolveDutyCounterparty(dutyDoc, raiserRole) {
        if (raiserRole === 'staff') {
            const hospital = await Hospital.findById(dutyDoc.hospital).select('user').lean();
            return hospital ? { userId: hospital.user, role: 'hospital' } : null;
        }
        const staff = await MedicalStaff.findById(dutyDoc.assignedTo).select('user').lean();
        return staff ? { userId: staff.user, role: 'staff' } : null;
    }

    async _createTicket(conversation, user, { category, confidence, subjectId, subjectDoc }) {
        const { resolutionClass, evidenceRequired } = await ticketCategoryConfigService.getByCategory(category);

        let raisedAgainst;
        if (resolutionClass === 'ADJUDICATED') {
            if (!subjectDoc) return { needsFormHandoff: true };
            raisedAgainst = await this._resolveDutyCounterparty(subjectDoc, user.role);
            if (!raisedAgainst) return { needsFormHandoff: true };
        }

        const text = conversation.messages
            .filter(m => m.sender === 'user')
            .map(m => m.selectedButton || m.text)
            .filter(Boolean)
            .join(' — ');

        const ticket = await ticketService.createTicket(user, {
            category,
            subjectType: subjectId ? 'DUTY' : 'NONE',
            subjectId: subjectId || null,
            raisedAgainst,
            text,
            source: 'CHATBOT',
            botCategory: category,
            botConfidence: confidence
        });

        return { ticket, evidenceRequired };
    }

    async sendMessage(user, { conversationId, text, selectedButton, files, language }) {
        const userId = user._id || user.id;
        let conversation = conversationId
            ? await TicketConversation.findOne({ _id: conversationId, user: userId, status: 'active' })
            : null;
        if (!conversation) {
            // Language is chosen once, at conversation start, and locked for
            // the thread — a `language` param on a message continuing an
            // existing conversation is ignored, not applied.
            conversation = new TicketConversation({ user: userId, role: user.role, language: language || 'en', messages: [] });
        }

        const step = this._deriveStep(conversation);
        conversation.messages.push({ sender: 'user', text: text || null, selectedButton: selectedButton || null, evidenceRefs: [], at: new Date() });

        // Fire-and-forget, same as every other socket push in this codebase
        // — purely ephemeral (nothing to persist or FCM-deliver), so it goes
        // straight through websocketManager rather than the notification
        // pipeline Day 3's chat messages use. Covers every branch below from
        // one place rather than scattering emits into each handler.
        websocketManager.emitToUser(userId, 'chatbot_typing', { conversationId: conversation._id, isTyping: true });

        let botMessage;
        if (step === 'AWAITING_CONFIRMATION' && selectedButton) {
            botMessage = await this._handleConfirmation(conversation, user, selectedButton);
        } else if (step === 'AWAITING_SUBJECT') {
            botMessage = await this._handleSubjectSelection(conversation, user, selectedButton);
        } else if (step === 'AWAITING_EVIDENCE') {
            botMessage = await this._handleEvidence(conversation, user, selectedButton, files);
        } else {
            botMessage = await this._handleFreshMessage(conversation, user, text, selectedButton);
        }

        websocketManager.emitToUser(userId, 'chatbot_typing', { conversationId: conversation._id, isTyping: false });

        conversation.messages.push(botMessage);
        await conversation.save();
        return conversation.toObject();
    }

    async _handleFreshMessage(conversation, user, text, selectedButton) {
        const language = conversation.language;
        // A domain quick-reply tap (see _domainQuickReplies) arrives as
        // selectedButton with no text — treated as the message itself,
        // same classify() path as free text.
        const effectiveMessage = (text && text.trim()) || selectedButton;
        if (!effectiveMessage) {
            return { sender: 'bot', text: t('emptyMessage', language), buttons: [], at: new Date() };
        }

        const history = conversation.messages.slice(0, -1);
        const result = await ticketIntentClassifier.classify({ history, message: effectiveMessage, language });

        if (result.intent === 'INFORMATIONAL') {
            return { sender: 'bot', text: result.reply, buttons: [], at: new Date() };
        }

        if (result.intent === 'UNCLEAR' || !result.category) {
            const userTurns = conversation.messages.filter(m => m.sender === 'user').length;
            if (userTurns >= MAX_CLARIFY_TURNS) {
                conversation.status = 'abandoned';
                return { sender: 'bot', text: t('formHandoff', language), buttons: [], at: new Date() };
            }
            return { sender: 'bot', text: result.reply, buttons: this._domainQuickReplies(language), at: new Date() };
        }

        // TICKET intent, below the confidence bar: don't loop a confirmation
        // dance around a guess we're not sure of — hand it straight to a
        // human via TRIAGE (exactly what that status/listTriage exist for).
        const threshold = await systemConfigService.getEffective(
            language === 'en' ? 'ticket.botConfidenceThresholdEn' : 'ticket.botConfidenceThresholdHiMr'
        );
        if (result.confidence < threshold) {
            const outcome = await this._createTicket(conversation, user, {
                category: result.category, confidence: result.confidence, subjectId: null, subjectDoc: null
            });
            if (outcome.needsFormHandoff) {
                conversation.status = 'abandoned';
                return { sender: 'bot', text: t('formHandoff', language), buttons: [], at: new Date() };
            }
            conversation.ticket = outcome.ticket._id;
            conversation.botCategory = result.category;
            conversation.botConfidence = result.confidence;
            return { sender: 'bot', text: evidenceAskText(outcome.ticket, outcome.evidenceRequired, language), buttons: [t('evidenceYes', language), t('evidenceNo', language)], at: new Date() };
        }

        conversation.botCategory = result.category;
        conversation.botConfidence = result.confidence;
        return { sender: 'bot', text: result.reply, buttons: [t('confirmYes', language), t('confirmNo', language)], at: new Date() };
    }

    async _handleConfirmation(conversation, user, selectedButton) {
        const language = conversation.language;
        if (selectedButton !== t('confirmYes', language)) {
            conversation.botCategory = null;
            conversation.botConfidence = null;
            return { sender: 'bot', text: t('confirmationDeclined', language), buttons: [], at: new Date() };
        }

        const category = conversation.botCategory;
        if (!category) {
            return { sender: 'bot', text: t('lostCategory', language), buttons: [], at: new Date() };
        }

        if (ticketIntentClassifier.isDutyLinked(category)) {
            const options = await this._dutyOptionsFor(user, language);
            if (options.length === 0) {
                return this._createAndAskEvidence(conversation, user, null, null);
            }
            const buttons = [...options.map(o => `${o.label} [${o.id}]`), t('skipSubject', language)];
            return { sender: 'bot', text: t('subjectLinkPrompt', language), buttons, at: new Date() };
        }

        return this._createAndAskEvidence(conversation, user, null, null);
    }

    async _handleSubjectSelection(conversation, user, selectedButton) {
        const match = selectedButton && selectedButton.match(/\[([a-f0-9]{24})\]$/);
        const rawSubjectId = match ? match[1] : null;

        // selectedButton is client-supplied — re-derive the duty from this
        // user's own list (not just Duty.findById on the raw id) so a
        // tampered button can't link/raise-against a duty that isn't
        // actually this user's.
        let subjectId = null;
        let subjectDoc = null;
        if (rawSubjectId) {
            const options = await this._dutyOptionsFor(user, conversation.language);
            if (options.some(o => o.id === rawSubjectId)) {
                subjectId = rawSubjectId;
                subjectDoc = await Duty.findById(subjectId).select('hospital assignedTo').lean();
            }
        }
        return this._createAndAskEvidence(conversation, user, subjectId, subjectDoc);
    }

    async _createAndAskEvidence(conversation, user, subjectId, subjectDoc) {
        const language = conversation.language;
        const outcome = await this._createTicket(conversation, user, {
            category: conversation.botCategory, confidence: conversation.botConfidence, subjectId, subjectDoc
        });
        if (outcome.needsFormHandoff) {
            conversation.status = 'abandoned';
            return { sender: 'bot', text: t('formHandoff', language), buttons: [], at: new Date() };
        }

        conversation.ticket = outcome.ticket._id;
        return { sender: 'bot', text: evidenceAskText(outcome.ticket, outcome.evidenceRequired, language), buttons: [t('evidenceYes', language), t('evidenceNo', language)], at: new Date() };
    }

    async _handleEvidence(conversation, user, selectedButton, files) {
        const language = conversation.language;
        const hasFiles = files && files.length > 0;
        if (!hasFiles && selectedButton === t('evidenceYes', language)) {
            return { sender: 'bot', text: t('evidenceWaiting', language), buttons: [], at: new Date() };
        }

        if (hasFiles) {
            await ticketService.addEvidence(conversation.ticket, user, files);
        }

        conversation.status = 'completed';
        return { sender: 'bot', text: t(hasFiles ? 'evidenceAttachedClose' : 'evidenceSkippedClose', language), buttons: [], at: new Date() };
    }
}

module.exports = new ChatbotIntakeService();
