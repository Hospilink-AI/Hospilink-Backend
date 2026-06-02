const DashboardService = require('../services/dashboard.service');
const logger = require('../utils/logger');

const LOCATION_TTL = 120;       // Redis TTL in seconds (2 minutes)
const UPDATE_INTERVAL = 30;     // send update every 30 seconds

function registerDashboardLocationHandlers(socket) {
    if (socket.user.role !== 'staff') return;

    const userId = socket.user.id.toString();

    // Client grants permission and sends first GPS coordinates
    socket.on('dashboard:location:grant', async (data) => {
        try {
            const { latitude, longitude } = data || {};

            if (typeof latitude !== 'number' || typeof longitude !== 'number') {
                return socket.emit('dashboard:location:error', {
                    message: 'latitude and longitude must be numbers'
                });
            }

            await DashboardService.grantDashboardLocationPermission(userId);
            const location = await DashboardService.setDashboardLocationViaSocket(userId, latitude, longitude);

            socket.emit('dashboard:location:confirmed', {
                success: true,
                event: 'granted',
                location,
                expiresIn: LOCATION_TTL,
                nextUpdateIn: UPDATE_INTERVAL
            });

            logger.info(`Dashboard location granted — staff ${userId}`);
        } catch (err) {
            logger.error(`dashboard:location:grant [${userId}]: ${err.message}`);
            socket.emit('dashboard:location:error', { message: err.message });
        }
    });

    // Client sends updated coordinates every 30 seconds — resets the 2-min TTL
    socket.on('dashboard:location:update', async (data) => {
        try {
            const { latitude, longitude } = data || {};

            if (typeof latitude !== 'number' || typeof longitude !== 'number') {
                return socket.emit('dashboard:location:error', {
                    message: 'latitude and longitude must be numbers'
                });
            }

            const location = await DashboardService.setDashboardLocationViaSocket(userId, latitude, longitude);

            socket.emit('dashboard:location:confirmed', {
                success: true,
                event: 'updated',
                location,
                expiresIn: LOCATION_TTL,
                nextUpdateIn: UPDATE_INTERVAL
            });
        } catch (err) {
            logger.error(`dashboard:location:update [${userId}]: ${err.message}`);
            socket.emit('dashboard:location:error', { message: err.message });
        }
    });

    // Client revokes permission (user clicked "Deny" or logged out)
    socket.on('dashboard:location:revoke', async () => {
        try {
            await DashboardService.revokeDashboardLocationPermission(userId);
            socket.emit('dashboard:location:confirmed', {
                success: true,
                event: 'revoked',
                message: 'Location permission revoked'
            });
            logger.info(`Dashboard location revoked — staff ${userId}`);
        } catch (err) {
            logger.error(`dashboard:location:revoke [${userId}]: ${err.message}`);
            socket.emit('dashboard:location:error', { message: err.message });
        }
    });

    // On disconnect: no explicit cleanup needed.
    // Redis 2-min TTL auto-expires the location key — stale location detection is built-in.
}

module.exports = { registerDashboardLocationHandlers };
