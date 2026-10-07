const { geminiModels, DEFAULT_MODELS } = require('../src/utils/geminiModels');

describe('gemini model list', () => {
    const saved = { model: process.env.GEMINI_MODEL, fallback: process.env.GEMINI_MODEL_FALLBACK };
    afterEach(() => {
        for (const [k, v] of [['GEMINI_MODEL', saved.model], ['GEMINI_MODEL_FALLBACK', saved.fallback]]) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    });

    it('falls back to current models when nothing is set', () => {
        delete process.env.GEMINI_MODEL;
        delete process.env.GEMINI_MODEL_FALLBACK;
        expect(geminiModels()).toEqual(DEFAULT_MODELS);
    });

    it('tries the configured model, then the fallback, then the defaults, once each', () => {
        process.env.GEMINI_MODEL = ' gemini-2.5-flash ';
        process.env.GEMINI_MODEL_FALLBACK = 'gemini-3.5-flash';
        expect(geminiModels()).toEqual(['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']);
    });
});
