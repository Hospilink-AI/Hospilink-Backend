// Every place that opens a PDF with pdf.js turns off script evaluation, so a
// crafted upload can't run code on the server (CVE-2024-4367)
const fs = require('fs');
const path = require('path');

function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

test('every getDocument call sets isEvalSupported: false', () => {
    const offenders = [];
    for (const file of sourceFiles(path.join(__dirname, '../src'))) {
        const source = fs.readFileSync(file, 'utf8');
        const calls = source.match(/getDocument\(\{[\s\S]*?\}\)/g) || [];
        for (const call of calls) {
            if (!/isEvalSupported:\s*false/.test(call)) offenders.push(path.basename(file));
        }
    }
    expect(offenders).toEqual([]);
});

test('runs on Node 22 LTS', () => {
    const pkg = require('../package.json');
    expect(pkg.engines.node).toBe('>=22');
    const docker = fs.readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8');
    expect(docker.match(/FROM node:22-slim/g)).toHaveLength(2);
});
