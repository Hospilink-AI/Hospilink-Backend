// Request data must never carry MongoDB operators. A body such as
// { "email": { "$ne": null } } would otherwise reach a query as an operator
// and match any account. Keys starting with "$" are removed from the body,
// the query string and route params on every request.

const MAX_DEPTH = 10;

function strip(value, depth = 0) {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return 0;
    let removed = 0;
    if (Array.isArray(value)) {
        for (const item of value) removed += strip(item, depth + 1);
        return removed;
    }
    for (const key of Object.keys(value)) {
        if (key.startsWith('$')) {
            delete value[key];
            removed++;
        } else {
            removed += strip(value[key], depth + 1);
        }
    }
    return removed;
}

function stripOperators(req, res, next) {
    const removed = strip(req.body) + strip(req.query) + strip(req.params);
    if (removed > 0) req.strippedOperators = removed;
    next();
}

module.exports = { stripOperators, strip };
