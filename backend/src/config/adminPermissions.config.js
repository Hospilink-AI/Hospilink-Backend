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
        'admin.view',
        'vacancy.view',
        'vacancy.manage',
        'application.view',
        'interview.config.manage',
        // Chatbot intake Phase 4 — same Operations floor as interview.config.manage
        'knowledgeBase.manage',

        // Disputes & Support — Operations floor (spec §07's route table)
        'ticket.view',
        'ticket.claim',
        'ticket.decide',
        'ticket.approve',
        'pattern.view',
        'suspension.decide',
        'feedback.view'
    ],
    tech_support: [
        'hospital.view',
        'staff.view',
        'duty.view',
        'document.view',
        'activityLog.view',

        // Disputes & Support — Support floor. Deliberately no
        // 'ticket.approve': Support can propose an outcome but any action
        // touching money, a rating, or account status needs a second admin
        // at Operations level or above (spec §07.03/§08.04).
        'ticket.view',
        'ticket.claim',
        'ticket.decide',

        // Spec update — Support now sees the feedback board, scoped in
        // feedback.service#listForAdmin to their own conversations only
        // (feedback that converted into a ticket assigned to them).
        'feedback.view'
    ]
};

function hasCapability(adminSubRole, capability) {
    if (adminSubRole === 'super_admin') return true;
    return (ADMIN_CAPABILITIES[adminSubRole] || []).includes(capability);
}

module.exports = { ADMIN_CAPABILITIES, hasCapability };
