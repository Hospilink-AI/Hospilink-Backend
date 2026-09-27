// Confirmed rule (ADMIN_RBAC_EXISTING_APIS.md §2.3): Operations Manager may see duty
// financial fields on single-duty views, but not on bulk/aggregate/list views.
// tech_support is unaffected by this rule — it is not read-only for financial data
// specifically, only for the endpoints it can already reach.
const DUTY_FINANCIAL_FIELDS = ['offeredRate', 'totalPayment'];

function stripDutyFinancials(duty) {
    if (!duty || typeof duty !== 'object') return duty;
    const clone = { ...duty };
    DUTY_FINANCIAL_FIELDS.forEach((field) => delete clone[field]);
    return clone;
}

// Apply to bulk/list duty responses before sending to an operations_manager.
function redactBulkDutyFinancials(duties, adminSubRole) {
    if (adminSubRole !== 'operations_manager' || !Array.isArray(duties)) return duties;
    return duties.map(stripDutyFinancials);
}

module.exports = { DUTY_FINANCIAL_FIELDS, stripDutyFinancials, redactBulkDutyFinancials };
