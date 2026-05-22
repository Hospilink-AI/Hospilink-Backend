const app = require('../src/app');
const connectDB = require('../src/config/database');

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
        // main db
        await connectDB();
        
        // Initialize Agent services for production
        const { initAgent } = require('../../agent/api');
        await initAgent();
        
        // Forward to Express app
        return app(req, res);
    } catch (error) {
        console.error('Serverless Function Error:', error);
        res.status(500).json({
            success: false,
            message: 'Serverless Function Error',
            error: error.message
        });
    }
};
