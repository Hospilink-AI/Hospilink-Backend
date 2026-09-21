// One-time seed: writes starter FAQ content into KnowledgeBaseArticle so
// the chatbot's informational-answer path (chatbot intake Phase 4) has real
// content instead of the single hand-written scene-setting paragraph.
// Safe to re-run — upserts by question text, so re-running updates the
// answer/category instead of creating duplicates, same spirit as
// seedTicketCategoryConfig.js's "safe to re-run" story.
//
// Usage: node scripts/seedKnowledgeBase.js
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const connectDB = require('../src/config/database');
const KnowledgeBaseArticle = require('../src/models/KnowledgeBaseArticle');

const ARTICLES = [
    {
        question: 'How does the OTP work for starting and ending a shift?',
        answer: "When you arrive for a shift, the hospital gives you a start OTP to confirm you're on-site; when the shift ends, the hospital gives you an end OTP to confirm it's complete. Both OTPs are entered in the app, not just told to someone.",
        category: 'duty'
    },
    {
        question: "What happens if I'm late to a shift?",
        answer: "Let the hospital know as soon as you can. A late arrival can affect your record, but showing up and completing the shift is always better than not showing up at all — if there's a dispute about it later, you can raise a ticket for either side to explain what happened.",
        category: 'duty'
    },
    {
        question: 'How do I withdraw a job application I already submitted?',
        answer: 'You can withdraw an application any time before it\'s been acted on — ask the chatbot to "withdraw my application" or raise a ticket under Applications.',
        category: 'jobs'
    },
    {
        question: 'When do I get paid for a completed shift?',
        answer: "Payment timing depends on the payment mode agreed with the hospital (cash, UPI, or bank transfer). If payment doesn't arrive as expected, you can raise a payment dispute and our team will look into it.",
        category: 'payment'
    },
    {
        question: "What if a hospital never shows up or isn't ready for my confirmed shift?",
        answer: "That's a hospital no-show, and you can raise it as a dispute — the platform reviews these against both parties' records to sort it fairly.",
        category: 'duty'
    },
    {
        question: 'How long does the platform take to respond to a dispute I raise?',
        answer: "It depends on how urgent the issue is. Safety issues and shifts happening right now get looked at fastest; everything else follows a set response window shown on your ticket once you raise it.",
        category: 'general'
    },
    {
        question: 'Can I appeal a decision I disagree with?',
        answer: 'Yes — once a ticket is decided, you can appeal it once, and it goes to a different, more senior reviewer than the one who made the original decision.',
        category: 'general'
    },
    {
        question: 'What happens if my account gets suspended?',
        answer: "You'll be notified with the reason and can respond/appeal within the window given. Suspension decisions always go through a second reviewer before they take effect.",
        category: 'account'
    },
    {
        question: 'How do I dispute a rating or review I think is unfair?',
        answer: 'Raise it as an account rating challenge, explaining why you believe it\'s inaccurate — the team will review it against the shift record.',
        category: 'account'
    },
    {
        question: 'What evidence should I attach to a dispute?',
        answer: "Whatever actually supports your side — screenshots, photos, messages, or documents. It's optional, but a stronger case usually has something concrete attached.",
        category: 'general'
    },
    {
        question: "Can I change the details of a shift after it's assigned?",
        answer: "You can request a change through the app; not everything can be changed after assignment, so the request goes to the team to review.",
        category: 'duty'
    },
    {
        question: 'What if I disagree with a no-show mark against me for an interview?',
        answer: "You can dispute an interview no-show within the dispute window from when it was marked — the platform reviews both sides' account of what happened.",
        category: 'jobs'
    },
    {
        question: 'How do I request a copy of my personal data?',
        answer: 'You can raise a data access request any time — this is a formal request handled under data-rights rules, with its own reviewer and no need for supporting evidence.',
        category: 'data'
    },
    {
        question: 'What happens if I lose access to my account?',
        answer: "Raise an account-locked issue and the team will help you regain access — if you're mid-shift when this happens, it's treated as high priority.",
        category: 'account'
    },
    {
        question: 'Is there a limit on how many times I can raise a dispute about the same thing?',
        answer: "No, but each specific issue (same category, same shift/application) can only have one open ticket at a time, so you won't end up with duplicates.",
        category: 'general'
    },
    {
        question: "What's the difference between raising a ticket and giving general feedback?",
        answer: "A ticket is for something specific that needs a decision or fix; feedback is for general thoughts or suggestions about the platform that don't need an individual resolution.",
        category: 'platform'
    },
    {
        question: 'Can a hospital raise a dispute against a staff member too?',
        answer: "Yes — disputes go both ways. A hospital can raise an issue about a staff member's conduct, a no-show, or other shift problems the same way staff can.",
        category: 'general'
    },
    {
        question: 'Can I add more evidence to a ticket after I first submit it?',
        answer: "Yes, you can add more evidence to an open ticket at any point before it's decided.",
        category: 'general'
    }
];

async function run() {
    await connectDB();

    let count = 0;
    for (const { question, answer, category } of ARTICLES) {
        await KnowledgeBaseArticle.findOneAndUpdate(
            { question },
            { question, answer, category, isActive: true },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        count++;
    }

    console.log(`Seeded ${count} knowledge base articles (expected ${ARTICLES.length}).`);
    process.exit(0);
}

run().catch((err) => {
    console.error('Failed to seed knowledge base:', err);
    process.exit(1);
});
