// Serverless entry point for Vercel
// Wraps the agent Express app as a serverless function

const { app, initAgent } = require('../api.js');

let initialized = false;
async function initialize() {
    if (initialized) return;
    await initAgent();
    initialized = true;
}

module.exports = async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', 'https://hospilink-frontend-ten.vercel.app');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With,Origin,Access-Control-Request-Method,Access-Control-Request-Headers,Cache-Control');
        res.setHeader('Access-Control-Max-Age', '86400');
        return res.status(204).end();
    }

    try {
        await initialize();
        return app(req, res);
    } catch (error) {
        console.error('Agent Serverless Error:', error);
        res.status(500).json({
            success: false,
            message: 'Agent Serverless Error',
            error: error.message
        });
    }
};
