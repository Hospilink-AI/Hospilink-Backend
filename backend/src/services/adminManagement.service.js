const User = require('../models/User');
const cacheService = require('./cache.service');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const { NotFoundError, ConflictError, ForbiddenError } = require('../middleware/error.middleware');


const ADMIN_PUBLIC_FIELDS = 'name email role adminSubRole isActive createdAt updatedAt';


class AdminManagementService {
    // Clears the cached session for a given admin so their next request re-reads
    // role/adminSubRole/isActive from the DB instead of a stale cache entry.
    // Used whenever another admin changes this admin's role or active status.
    async _invalidateSession(adminId) {
        await cacheService.del(`session:${adminId}`);
    }

    async createAdmin({ name, email, password, adminSubRole }) {
        const existing = await User.findOne({ email });
        if (existing) {
            throw new ConflictError('An account with this email already exists.');
        }

        const admin = await User.create({
            name,
            email,
            password,
            role: 'admin',
            adminSubRole,
            isEmailVerified: true,
            isActive: true
        });

        return {
            id: admin._id,
            name: admin.name,
            email: admin.email,
            role: admin.role,
            adminSubRole: admin.adminSubRole,
            isActive: admin.isActive,
            createdAt: admin.createdAt
        };
    }



    async listAdmins({ adminSubRole, includeInactive, page, limit }) {
        const { skip } = getPaginationParams(page, limit);

        const query = { role: 'admin' };
        if (adminSubRole) query.adminSubRole = adminSubRole;
        if (!includeInactive) query.isActive = { $ne: false };

        const [admins, total] = await Promise.all([
            User.find(query)
                .select(ADMIN_PUBLIC_FIELDS)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            User.countDocuments(query)
        ]);

        return {
            admins,
            pagination: getPaginationMeta(total, page, limit)
        };
    }




    async getAdminDetail(adminId) {
        const admin = await User.findOne({ _id: adminId, role: 'admin' })
            .select(ADMIN_PUBLIC_FIELDS)
            .lean();

        if (!admin) {
            throw new NotFoundError('Admin not found');
        }

        return admin;
    }




    async changeAdminRole(adminId, newSubRole, requestingAdminId) {
        if (String(adminId) === String(requestingAdminId)) {
            throw new ForbiddenError('You cannot change your own admin sub-role. Ask another super admin, or use direct DB access.');
        }

        const admin = await User.findOne({ _id: adminId, role: 'admin' });
        if (!admin) {
            throw new NotFoundError('Admin not found');
        }

        const previousSubRole = admin.adminSubRole;

        admin.adminSubRole = newSubRole;
        await admin.save();

        // Live-refresh: clear the cached session so the target admin's very next
        // request re-reads the new adminSubRole from the DB. Not a forced logout —
        // a role change is a permission update, not a security lockout.
        await this._invalidateSession(adminId);

        return {
            id: admin._id,
            name: admin.name,
            email: admin.email,
            previousSubRole,
            newSubRole: admin.adminSubRole
        };
    }



    async deactivateAdmin(adminId, requestingAdminId) {
        if (String(adminId) === String(requestingAdminId)) {
            throw new ForbiddenError('You cannot deactivate your own account. Ask another super admin, or use direct DB access.');
        }

        const admin = await User.findOne({ _id: adminId, role: 'admin' });
        if (!admin) {
            throw new NotFoundError('Admin not found');
        }

        // Super admins can only be deactivated via direct DB access, never through this API —
        // regardless of who's asking. Only operations_manager / tech_support accounts qualify.
        if (admin.adminSubRole === 'super_admin') {
            throw new ForbiddenError('You cannot deactivate another super admin account. This can only be done via direct DB access.');
        }

        if (admin.isActive === false) {
            throw new ConflictError('This admin account is already deactivated.');
        }

        admin.isActive = false;
        await admin.save();

        // Force-logout: deactivation is a security action, so clear the cached
        // session immediately. Combined with the isActive check in protect(),
        // this admin's very next request will be rejected even mid-session.
        await this._invalidateSession(adminId);

        return {
            id: admin._id,
            name: admin.name,
            email: admin.email,
            isActive: admin.isActive
        };
    }



    
    async activateAdmin(adminId) {
        const admin = await User.findOne({ _id: adminId, role: 'admin' });
        if (!admin) {
            throw new NotFoundError('Admin not found');
        }

        // Mirrors the deactivate restriction: only operations_manager / tech_support accounts
        // can be activated through this API — a super_admin's isActive state (however it got
        // there) can only be changed via direct DB access. No self-check is needed here: a
        // deactivated admin can't authenticate at all, so they could never call this endpoint
        // as themselves in the first place.
        if (admin.adminSubRole === 'super_admin') {
            throw new ForbiddenError('You cannot activate a super admin account. This can only be done via direct DB access.');
        }

        if (admin.isActive !== false) {
            throw new ConflictError('This admin account is already active.');
        }

        admin.isActive = true;
        await admin.save();

        return {
            id: admin._id,
            name: admin.name,
            email: admin.email,
            adminSubRole: admin.adminSubRole,
            isActive: admin.isActive
        };
    }
}

module.exports = new AdminManagementService();
