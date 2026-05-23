const { startServer } = require('../api');

module.exports = async (req, res) => {
    // Start the agent server if not already started
    const app = await startServer();
    
    // Handle the request through the Express app
    return app(req, res);
};