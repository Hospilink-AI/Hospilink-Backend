const axios = require('axios');
const logger = require('../utils/logger');

class DeviceInfoService {
    // Extract device information from request
    extractDeviceInfo(req) {
        const ip = this.getClientIP(req);
        const userAgent = req.headers['user-agent'] || 'Unknown';
        const deviceName = this.parseUserAgent(userAgent);

        return {
            ip,
            userAgent,
            deviceName
        };
    }

    
    // get client IP address from request
    getClientIP(req) {
        // Check for forwarded headers first (behind proxy/Docker)
        const forwardedFor = req.headers['x-forwarded-for'];
        if (forwardedFor) {
            // x-forwarded-for can contain multiple IPs, take the first one (original client)
            return forwardedFor.split(',')[0].trim();
        }
        
        // Check for real IP header
        const realIP = req.headers['x-real-ip'];
        if (realIP) {
            return realIP.trim();
        }
        
        // Fallback to direct connection IP
        return req.ip || 
            req.connection?.remoteAddress || 
            req.socket?.remoteAddress ||
            (req.connection?.socket ? req.connection.socket.remoteAddress : null) ||
            '0.0.0.0';
    }

    

    // parse user agent to get device name
    parseUserAgent(userAgent) {
        if (!userAgent || userAgent === 'Unknown') {
            return 'Unknown Device';
        }

        let deviceName = 'Unknown Device';

        // Detect browser
        if (userAgent.includes('Chrome')) {
            deviceName = 'Chrome Browser';
        } else if (userAgent.includes('Firefox')) {
            deviceName = 'Firefox Browser';
        } else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
            deviceName = 'Safari Browser';
        } else if (userAgent.includes('Edge')) {
            deviceName = 'Edge Browser';
        } else if (userAgent.includes('Opera')) {
            deviceName = 'Opera Browser';
        }

        // Detect OS
        if (userAgent.includes('Windows')) {
            deviceName += ' on Windows';
        } else if (userAgent.includes('Mac')) {
            deviceName += ' on macOS';
        } else if (userAgent.includes('Linux')) {
            deviceName += ' on Linux';
        } else if (userAgent.includes('Android')) {
            deviceName += ' on Android';
        } else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) {
            deviceName += ' on iOS';
        }

        return deviceName;
    }

    

    // get location from IP address using free IP geolocation API
    async getLocationFromIP(ip) {
        try {
            if (this.isPrivateIP(ip)) {
                // Try to get external IP for better location detection
                try {
                    const externalIPResponse = await axios.get('https://api.ipify.org?format=json', {
                        timeout: 3000
                    });
                    
                    if (externalIPResponse.data.ip) {
                        ip = externalIPResponse.data.ip;
                        logger.info(`Using external IP for location: ${ip}`);
                    } else {
                        return {
                            city: 'Local Network',
                            region: 'Local',
                            country: 'Local'
                        };
                    }
                } catch (externalError) {
                    logger.warn(`Failed to get external IP: ${externalError.message}`);
                    return {
                        city: 'Local Network',
                        region: 'Local',
                        country: 'Local'
                    };
                }
            }

            // Use free IP geolocation API (ip-api.com)
            const response = await axios.get(`http://ip-api.com/json/${ip}`, {
                timeout: 5000
            });

            if (response.data && response.data.status === 'success') {
                const location = {
                    city: response.data.city || 'Unknown',
                    region: response.data.regionName || 'Unknown',
                    country: response.data.country || 'Unknown'
                };
                
                logger.info(`Location detected for IP ${ip}: ${location.city}, ${location.region}, ${location.country}`);
                return location;
            }

            // Try alternative API as fallback
            logger.warn(`ip-api.com failed for IP ${ip}, trying alternative...`);
            const altResponse = await axios.get(`https://ipinfo.io/${ip}/json`, {
                timeout: 5000
            });

            if (altResponse.data) {
                const location = {
                    city: altResponse.data.city || 'Unknown',
                    region: altResponse.data.region || 'Unknown',
                    country: altResponse.data.country || 'Unknown'
                };
                
                logger.info(`Location detected via alternative API for IP ${ip}: ${location.city}, ${location.region}, ${location.country}`);
                return location;
            }

            // Final fallback
            logger.warn(`All location APIs failed for IP ${ip}`);
            return {
                city: 'Unknown',
                region: 'Unknown',
                country: 'Unknown'
            };
        } catch (error) {
            logger.error(`Error getting location from IP ${ip}: ${error.message}`);
            return {
                city: 'Unknown',
                region: 'Unknown',
                country: 'Unknown'
            };
        }
    }

    

    // check if IP is private/local
    isPrivateIP(ip) {
        if (!ip) return true;
        
        // Handle IPv6-mapped IPv4 addresses (::ffff:192.168.x.x)
        if (ip.startsWith('::ffff:')) {
            const ipv4Part = ip.substring(7); // Remove ::ffff: prefix
            ip = ipv4Part;
        }
        
        const privateRanges = [
            /^127\./,           // Loopback
            /^10\./,            // Private Class A
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./,  // Private Class B
            /^192\.168\./,      // Private Class C
            /^169\.254\./,      // Link-local
            /^::1$/,            // IPv6 Loopback
            /^fc00:/,           // IPv6 Private
            /^fe80:/,           // IPv6 Link-local
            /^::ffff:127\./,    // IPv6-mapped loopback
            /^::ffff:10\./,     // IPv6-mapped Class A
            /^::ffff:172\.(1[6-9]|2[0-9]|3[0-1])\./,  // IPv6-mapped Class B
            /^::ffff:192\.168\./ // IPv6-mapped Class C
        ];

        return privateRanges.some(range => range.test(ip));
    }

    

    // generate a unique device ID based on IP and User-Agent
    generateDeviceId(ip, userAgent) {
        const crypto = require('crypto');
        const deviceString = `${ip}-${userAgent}`;
        return crypto.createHash('sha256').update(deviceString).digest('hex').substring(0, 32);
    }
}

module.exports = new DeviceInfoService();