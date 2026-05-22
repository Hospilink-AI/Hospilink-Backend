const app = require('../src/app');
const connectDB = require('../src/config/database');

module.exports = async (req, res) => {
    try {
        // main db
        await connectDB();
        
        // Initialize Agent services for production
        const { initAgent } = require('../agent/api');
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
