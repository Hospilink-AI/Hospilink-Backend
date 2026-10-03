const XLSX = require('xlsx');

// Turns a section response into flat tables: tiles first, then one per chart
function toTables(result) {
    const tables = [{
        name: 'Summary',
        rows: result.tiles.map(t => ({
            kpi: t.label,
            value: t.value,
            previousPeriod: t.previous,
            changePct: t.deltaPct,
            unit: t.unit,
            projected: t.isProjected ? 'yes' : ''
        }))
    }];

    for (const chart of result.charts) {
        let rows = [];
        if (chart.series) rows = chart.series;
        else if (chart.stages) rows = chart.stages.map(s => ({ stage: s.label, value: s.value }));
        else if (chart.cells) {
            rows = chart.yLabels.map((label, y) => ({
                day: label,
                ...Object.fromEntries(chart.xLabels.map((x, i) => [x, chart.cells[y][i]]))
            }));
        } else if (chart.type === 'cohort') {
            rows = chart.rows.map(r => ({
                cohort: r.cohort,
                size: r.size,
                ...Object.fromEntries(r.retention.map((v, i) => [`month${i}`, v]))
            }));
        } else if (chart.rows) rows = chart.rows;

        tables.push({ name: chart.title || chart.key, rows: rows.map(flatten) });
    }

    return tables;
}

// Nested objects become dotted columns; arrays are joined
function flatten(row, prefix = '', out = {}) {
    for (const [key, value] of Object.entries(row)) {
        const column = prefix ? `${prefix}.${key}` : key;
        if (Array.isArray(value)) out[column] = value.join(' | ');
        else if (value && typeof value === 'object' && !(value instanceof Date)) flatten(value, column, out);
        else out[column] = value;
    }
    return out;
}

const csvCell = (value) => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function toCsv(result) {
    const lines = [
        `# ${result.section} analytics, ${result.period.from} to ${result.period.to} (${result.period.granularity})`
    ];
    for (const table of toTables(result)) {
        lines.push('', `# ${table.name}`);
        const columns = [...new Set(table.rows.flatMap(r => Object.keys(r)))];
        if (!columns.length) {
            lines.push('No data');
            continue;
        }
        lines.push(columns.map(csvCell).join(','));
        for (const row of table.rows) lines.push(columns.map(c => csvCell(row[c])).join(','));
    }
    if (result.dataNotes?.length) {
        lines.push('', '# Notes', ...result.dataNotes.map(csvCell));
    }
    return lines.join('\n');
}

function toXlsx(result) {
    const workbook = XLSX.utils.book_new();
    const used = new Set();
    for (const table of toTables(result)) {
        // Sheet names: 31 characters, no []:*?/\ and unique
        let name = table.name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 28).trim() || 'Sheet';
        let unique = name;
        for (let i = 2; used.has(unique.toLowerCase()); i++) unique = `${name} ${i}`;
        used.add(unique.toLowerCase());

        const sheet = table.rows.length ? XLSX.utils.json_to_sheet(table.rows) : XLSX.utils.aoa_to_sheet([['No data']]);
        XLSX.utils.book_append_sheet(workbook, sheet, unique);
    }
    if (result.dataNotes?.length) {
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(result.dataNotes.map(n => [n])), 'Notes');
    }
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { toTables, toCsv, toXlsx };
