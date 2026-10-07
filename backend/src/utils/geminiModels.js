// Gemini models to try, in order: GEMINI_MODEL, GEMINI_MODEL_FALLBACK, then
// current stable defaults, so an unset or retired model name doesn't switch
// the chatbot or resume parsing off. Google has limited the 2.5 models to
// projects that already used them.
const DEFAULT_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];

function geminiModels() {
    const names = [process.env.GEMINI_MODEL, process.env.GEMINI_MODEL_FALLBACK, ...DEFAULT_MODELS]
        .map(name => (name || '').trim())
        .filter(Boolean);
    return [...new Set(names)];
}

module.exports = { geminiModels, DEFAULT_MODELS };
