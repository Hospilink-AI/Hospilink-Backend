const Hospital = require('../models/Hospital');
const { ValidationError } = require('../middleware/error.middleware');
const { escapeRegex } = require('./admin/helpers');

class AdminService {
    // Parse DD-MM-YYYY format to Date object
    parseDDMMYYYY(dateString) {
        if (!dateString) return null;

        const parts = dateString.split('-');
        if (parts.length !== 3) return null;

        const day = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1; // JavaScript months are 0-indexed
        const year = parseInt(parts[2], 10);

        if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
        if (day < 1 || day > 31) return null;
        if (month < 0 || month > 11) return null;
        if (year < 1900 || year > 2100) return null;

        const date = new Date(year, month, day);
        // Validate that the date is valid 
        if (date.getDate() !== day || date.getMonth() !== month || date.getFullYear() !== year) {
            return null;
        }

        return date;
    }

    // Build date filter based on parameters
    buildDateFilter(startDate, endDate, date) {
        let dateFilter = {};

        if (date) {
            // Single date filter
            const targetDate = this.parseDDMMYYYY(date);
            if (!targetDate) {
                throw new ValidationError('Invalid date format. Use DD-MM-YYYY format');
            }

            dateFilter = {
                $gte: new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate()),
                $lt: new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate() + 1)
            };
        } else if (startDate && endDate) {
            // Date range filter
            const start = this.parseDDMMYYYY(startDate);
            const end = this.parseDDMMYYYY(endDate);

            if (!start || !end) {
                throw new ValidationError('Invalid date format. Use DD-MM-YYYY format');
            }

            if (start > end) {
                throw new ValidationError('Start date must be before or equal to end date');
            }

            dateFilter = {
                $gte: new Date(start.getFullYear(), start.getMonth(), start.getDate()),
                $lt: new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1) // Include end date
            };
        } else {
            // Default to today
            const today = new Date();
            dateFilter = {
                $gte: new Date(today.getFullYear(), today.getMonth(), today.getDate()),
                $lt: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
            };
        }

        return dateFilter;
    }

    // Build location filter for city and sub-regions
    async buildLocationFilter(location) {
        try {
            // Normalize location input
            const normalizedLocation = escapeRegex(location.toLowerCase().trim());
            
            // Get all hospitals in specified city/region
            const hospitals = await Hospital.find({
                $or: [
                    { location: { $regex: normalizedLocation, $options: 'i' } },
                    { currentAddress: { $regex: normalizedLocation, $options: 'i' } }
                ]
            }).select('_id');

            if (hospitals.length === 0) {
                return null; // No hospitals found in this location
            }

            const hospitalIds = hospitals.map(h => h._id);
            
            return {
                hospital: { $in: hospitalIds }
            };
        } catch (error) {
            console.error('Error building location filter:', error);
            return null;
        }
    }
}

// The methods live in ./admin/, one file per area
Object.assign(AdminService.prototype,
    require('./admin/dashboard'),
    require('./admin/staff'),
    require('./admin/hospitals'),
    require('./admin/documents'),
    require('./admin/duties'),
    require('./admin/vacancies'),
    require('./admin/settings'),
    require('./admin/overrides')
);

module.exports = new AdminService();
