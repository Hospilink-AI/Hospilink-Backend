// Fixed chatbot UI copy — buttons, prompts, closing lines — in English,
// Hindi, and Marathi (chatbot intake Phase 3). Dynamic/generated text (the
// classifier's confirmation sentence, informational answers, clarifying
// questions) is handled separately by Gemini itself, in
// ticketIntentClassifier.service.js — this file is only for the small,
// fixed, enumerable set of strings the orchestrator itself controls.
//
// These are my own best-effort translations, not a professional or native
// review — have a fluent Hindi/Marathi speaker sanity-check them before
// relying on this for real users.
//
// Evidence item names (Phase 2's evidenceRequired content) and duty/
// hospital/staff names are deliberately left in English even inside a
// Hindi/Marathi sentence — code-mixing English technical terms is normal
// Indian app UX (this codebase already keeps "OTP" as-is everywhere), and
// proper nouns/dates were never translatable content to begin with.
const COPY = {
    confirmYes: { en: "Yes, that's right", hi: 'हाँ, यह सही है', mr: 'होय, हे बरोबर आहे' },
    confirmNo: { en: 'No, let me pick', hi: 'नहीं, मुझे खुद चुनने दें', mr: 'नाही, मला स्वतः निवडू द्या' },
    skipSubject: { en: 'Not sure / none of these', hi: 'पक्का नहीं / इनमें से कोई नहीं', mr: 'खात्री नाही / यापैकी कोणतेही नाही' },
    subjectLinkPrompt: { en: 'Which shift is this about?', hi: 'यह किस शिफ्ट के बारे में है?', mr: 'ही कोणत्या शिफ्टबद्दल आहे?' },
    evidenceYes: { en: 'I have evidence to add', hi: 'मेरे पास जोड़ने के लिए सबूत है', mr: 'माझ्याकडे जोडण्यासाठी पुरावा आहे' },
    evidenceNo: { en: 'No evidence, skip', hi: 'कोई सबूत नहीं, आगे बढ़ें', mr: 'पुरावा नाही, पुढे जा' },
    evidenceWaiting: {
        en: "Go ahead and attach the file(s) whenever you're ready.",
        hi: 'जब भी आप तैयार हों, फ़ाइल(फ़ाइलें) संलग्न करें।',
        mr: 'तुम्ही तयार असाल तेव्हा फाइल(फायली) जोडा.'
    },
    formHandoff: {
        en: 'This kind of issue needs a bit more detail than I can collect here — please use "Raise a ticket" from the menu instead so you can give the full details.',
        hi: 'इस तरह के मामले में यहाँ से ज़्यादा जानकारी चाहिए — कृपया मेनू में "Raise a ticket" का उपयोग करें ताकि आप पूरी जानकारी दे सकें।',
        mr: 'अशा प्रकारच्या समस्येसाठी इथून जास्त तपशील हवा — कृपया मेनूमधील "Raise a ticket" वापरा जेणेकरून तुम्ही संपूर्ण माहिती देऊ शकाल.'
    },
    emptyMessage: {
        en: "Sorry, I didn't catch that — could you tell me what's going on?",
        hi: 'माफ़ कीजिए, मैं समझ नहीं पाया — क्या आप बता सकते हैं कि क्या हुआ?',
        mr: 'माफ करा, मला ते समजले नाही — काय झाले ते सांगू शकाल का?'
    },
    lowConfidenceCreated: {
        en: "I've flagged this for our team to review and categorise (ticket {ticketId}) — I'm not fully sure of the exact category myself.",
        hi: 'मैंने इसे हमारी टीम को समीक्षा और वर्गीकरण के लिए भेज दिया है (टिकट {ticketId}) — मुझे खुद सही श्रेणी को लेकर पूरा यकीन नहीं है।',
        mr: 'मी हे आमच्या टीमकडे पुनरावलोकन आणि वर्गीकरणासाठी पाठवले आहे (तिकीट {ticketId}) — मला स्वतःला योग्य श्रेणीबद्दल पूर्ण खात्री नाही.'
    },
    confirmationDeclined: {
        en: 'No problem — tell me more about what happened, or which category fits best.',
        hi: 'कोई बात नहीं — मुझे बताएं कि क्या हुआ, या कौन-सी श्रेणी सबसे सही लगती है।',
        mr: 'हरकत नाही — काय झाले ते सांगा, किंवा कोणती श्रेणी योग्य वाटते ते सांगा.'
    },
    lostCategory: {
        en: 'Sorry, I lost track of that — could you describe the issue again?',
        hi: 'माफ़ कीजिए, मैं वह भूल गया — क्या आप समस्या फिर से बता सकते हैं?',
        mr: 'माफ करा, मी ते विसरलो — तुम्ही समस्या पुन्हा सांगू शकाल का?'
    },
    evidenceAttachedClose: {
        en: 'Thanks, I\'ve attached that to your ticket. You can track it under "My Tickets".',
        hi: 'धन्यवाद, मैंने इसे आपके टिकट से जोड़ दिया है। आप इसे "My Tickets" में देख सकते हैं।',
        mr: 'धन्यवाद, मी ते तुमच्या तिकिटाला जोडले आहे. तुम्ही ते "My Tickets" मध्ये पाहू शकता.'
    },
    evidenceSkippedClose: {
        en: 'No problem — you can track your ticket under "My Tickets".',
        hi: 'कोई बात नहीं — आप अपना टिकट "My Tickets" में देख सकते हैं।',
        mr: 'हरकत नाही — तुम्ही तुमचे तिकीट "My Tickets" मध्ये पाहू शकता.'
    },
    evidenceAskBase: {
        en: "I've raised ticket {ticketId} for this.",
        hi: 'मैंने इसके लिए टिकट {ticketId} बना दिया है।',
        mr: 'मी यासाठी तिकीट {ticketId} तयार केले आहे.'
    },
    evidenceAskGeneric: {
        en: "Do you have any evidence — photos, screenshots, or documents — you'd like to attach?",
        hi: 'क्या आपके पास कोई सबूत है — फ़ोटो, स्क्रीनशॉट, या दस्तावेज़ — जो आप जोड़ना चाहेंगे?',
        mr: 'तुमच्याकडे काही पुरावा आहे का — फोटो, स्क्रीनशॉट किंवा कागदपत्रे — जे तुम्हाला जोडायचे आहेत?'
    },
    evidenceAskSpecific: {
        en: 'This kind of issue is usually stronger with: {items}. Do you have any of these to attach?',
        hi: 'इस तरह के मामले में यह होना मददगार होता है: {items}। क्या आपके पास इनमें से कुछ है जो आप जोड़ सकें?',
        mr: 'अशा प्रकारच्या समस्येसाठी हे उपयुक्त ठरते: {items}. यापैकी काही तुमच्याकडे आहे का?'
    },
    dutyOptionForStaff: { en: '{role} at {hospital} — {date}', hi: '{hospital} में {role} — {date}', mr: '{hospital} येथे {role} — {date}' },
    dutyOptionForHospital: { en: '{role} with {staffName} — {date}', hi: '{staffName} के साथ {role} — {date}', mr: '{staffName} सोबत {role} — {date}' },
    shiftFallback: { en: 'Shift', hi: 'शिफ्ट', mr: 'शिफ्ट' },
    hospitalFallback: { en: 'the hospital', hi: 'अस्पताल', mr: 'रुग्णालय' },
    staffFallback: { en: 'staff', hi: 'कर्मचारी', mr: 'कर्मचारी' },
    classifierNoKeyFallback: {
        en: "Sorry, could you tell me a bit more about what's going on?",
        hi: 'माफ़ कीजिए, क्या आप थोड़ा और बता सकते हैं कि क्या हुआ?',
        mr: 'माफ करा, काय झाले याबद्दल थोडे अधिक सांगू शकाल का?'
    },
    classifierAllModelsFailedFallback: {
        en: "Sorry, I didn't quite catch that — could you rephrase?",
        hi: 'माफ़ कीजिए, मैं ठीक से समझ नहीं पाया — क्या आप इसे दूसरे तरीके से कह सकते हैं?',
        mr: 'माफ करा, मला ते नीट समजले नाही — तुम्ही ते वेगळ्या पद्धतीने सांगू शकाल का?'
    },

    // Chatbot intake Phase 5 — domain quick-replies offered on an UNCLEAR
    // turn, one per ticket.constants.js DOMAINS entry plus a catch-all.
    domainDuty: { en: "It's about a shift", hi: 'यह शिफ्ट के बारे में है', mr: 'हे शिफ्टबद्दल आहे' },
    domainPayment: { en: "It's about payment", hi: 'यह भुगतान के बारे में है', mr: 'हे पेमेंटबद्दल आहे' },
    domainSafety: { en: "It's a safety concern", hi: 'यह सुरक्षा से जुड़ा मामला है', mr: 'ही सुरक्षेशी संबंधित बाब आहे' },
    domainJobs: { en: "It's about a job application", hi: 'यह नौकरी के आवेदन के बारे में है', mr: 'हे नोकरीच्या अर्जाबद्दल आहे' },
    domainAccount: { en: "It's about my account", hi: 'यह मेरे खाते के बारे में है', mr: 'हे माझ्या खात्याबद्दल आहे' },
    domainPlatform: { en: "It's about the app itself", hi: 'यह ऐप से जुड़ी बात है', mr: 'हे अ‍ॅपशी संबंधित आहे' },
    domainData: { en: "It's about my data", hi: 'यह मेरे डेटा के बारे में है', mr: 'हे माझ्या डेटाबद्दल आहे' },
    domainOther: { en: 'Something else', hi: 'कुछ और', mr: 'आणखी काही' }
};

function t(key, language, vars = {}) {
    const entry = COPY[key];
    if (!entry) throw new Error(`botCopy: unknown key "${key}"`);
    const lang = entry[language] ? language : 'en';
    let text = entry[lang];
    for (const [k, v] of Object.entries(vars)) {
        text = text.replaceAll(`{${k}}`, v);
    }
    return text;
}

module.exports = { COPY, t };
