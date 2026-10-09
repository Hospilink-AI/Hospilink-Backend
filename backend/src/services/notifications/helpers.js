// Shared helpers for notificationEmitter.js and its method groups in ./

// Same formatting ticketConsequence.service.js's own (unexported)
// humanizeCategory uses — duplicated as a one-liner rather than importing
// across that boundary for a single string transform.
function humanizeTicketCategory(category) {
    return category.replace('.', ' — ').replace(/_/g, ' ');
}

module.exports = { humanizeTicketCategory };
