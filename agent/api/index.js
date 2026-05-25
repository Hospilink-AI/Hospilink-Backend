// Serverless entry point for Vercel
const { app } = require('../api.js');
const { connect } = require('../modules/storage');
const { getAllowedOriginsRaw } = require('../utils/cors.config');

module.exports = async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        const allowed = getAllowedOriginsRaw();
        const requestOrigin = req.headers.origin;
        const originHeader = allowed
            ? (allowed.includes(requestOrigin) ? requestOrigin : allowed[0])
            : (requestOrigin || '*');
        res.setHeader('Access-Control-Allow-Origin', originHeader);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With,Origin,Access-Control-Request-Method,Access-Control-Request-Headers,Cache-Control');
        res.setHeader('Access-Control-Max-Age', '86400');
        return res.status(204).end();
    }

    try {
        // Reconnect on every request — Vercel drops idle connections between invocations
        await connect();
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
