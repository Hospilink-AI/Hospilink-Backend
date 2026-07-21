// Central capability matrix for admin sub-roles.
// `super_admin` always bypasses this matrix — see hasCapability() below.
const ADMIN_CAPABILITIES = {
    operations_manager: [
        'hospital.view',
        'hospital.manage',
        'staff.view',
        'staff.manage',
        'duty.view',
        'duty.manage',
        'duty.export',
        'document.view',
        'document.manage',
        'activityLog.view',
        'dashboard.view',
        'admin.view'
    ],
    tech_support: [
        'hospital.view',
        'staff.view',
        'duty.view',
        'document.view',
        'activityLog.view'
    ]
};

function hasCapability(adminSubRole, capability) {
    if (adminSubRole === 'super_admin') return true;
    return (ADMIN_CAPABILITIES[adminSubRole] || []).includes(capability);
}

module.exports = { ADMIN_CAPABILITIES, hasCapability };
