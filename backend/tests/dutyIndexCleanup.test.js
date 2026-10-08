// Every duty write updates every index, so no Duty index may repeat another:
// one whose keys start a longer index (same directions, or all reversed) is
// served by the longer one
const Duty = require('../src/models/Duty');

const plain = (options = {}) => !options.unique && !options.sparse && !options.partialFilterExpression;

function servedBy(shorter, longer) {
    const a = Object.entries(shorter);
    const b = Object.entries(longer);
    if (a.length > b.length) return false;
    const same = a.every(([key, dir], i) => b[i][0] === key && b[i][1] === dir);
    const reversed = a.every(([key, dir], i) => b[i][0] === key && b[i][1] === -dir);
    return same || reversed;
}

test('no index repeats another', () => {
    const indexes = Duty.schema.indexes();
    const repeats = [];
    indexes.forEach(([keys, options], i) => {
        if (!plain(options)) return;
        indexes.forEach(([other, otherOptions], j) => {
            if (i === j) return;
            const sameLength = Object.keys(keys).length === Object.keys(other).length;
            // Of two equal-length repeats, report only one
            if (sameLength && j > i) return;
            if (servedBy(keys, other)) repeats.push(`${JSON.stringify(keys)} is served by ${JSON.stringify(other)}`);
        });
    });
    expect(repeats).toEqual([]);
});

test('the indexes the duty queries rely on are still there', () => {
    const keys = Duty.schema.indexes().map(([k]) => JSON.stringify(k));
    expect(keys).toEqual(expect.arrayContaining([
        JSON.stringify({ hospital: 1, status: 1, date: -1 }),
        JSON.stringify({ assignedTo: 1, status: 1, date: 1 }),
        JSON.stringify({ staffRole: 1, status: 1, date: 1 }),
        JSON.stringify({ status: 1, assignedTo: 1, assignedAt: -1 }),
        JSON.stringify({ createdAt: 1, status: 1 }),
        JSON.stringify({ 'autoRelist.relistCount': 1 }),
        JSON.stringify({ date: 1 })
    ]));
});
