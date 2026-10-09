// One-time clean-up: mask every Aadhaar number already stored in Aadhaar
// document entries to its last 4 digits (UIDAI rules). New uploads are
// masked when saved; this covers the ones from before.
//
// Touches only Aadhaar entries, and only these fields: extractedText,
// extractedData and verificationMeta.rawResponse. Nothing else changes.
// Safe to re-run: masked values are left alone.
//
// Usage (from backend/):
//   node scripts/maskAadhaarNumbers.js            dry run: counts only, writes nothing
//   node scripts/maskAadhaarNumbers.js --apply    masks them
//
// Prints counts only, never a number or a name.
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const connectDB = require('../src/config/database');
const Document = require('../src/models/Document');
const { maskedEntryFields } = require('../src/utils/aadhaarMask');

const APPLY = process.argv.includes('--apply');

async function run() {
    await connectDB();
    const cursor = Document.find({ 'documents.documentType': 'aadhaar-card' })
        .select('documents._id documents.documentType documents.extractedText documents.extractedData documents.verificationMeta')
        .lean()
        .cursor();

    let records = 0;
    let entries = 0;
    let needMasking = 0;
    let masked = 0;

    for await (const record of cursor) {
        records++;
        for (const entry of record.documents || []) {
            if (entry.documentType !== 'aadhaar-card') continue;
            entries++;
            const changes = maskedEntryFields(entry);
            if (!changes) continue;
            needMasking++;
            if (!APPLY) continue;
            const $set = {};
            for (const [path, value] of Object.entries(changes)) $set[`documents.$[entry].${path}`] = value;
            // Raw update on purpose: only these fields, no hooks or timestamps
            const result = await Document.collection.updateOne(
                { _id: record._id },
                { $set },
                { arrayFilters: [{ 'entry._id': entry._id }] }
            );
            masked += result.modifiedCount;
        }
    }

    console.log(`Records with an Aadhaar: ${records}`);
    console.log(`Aadhaar entries: ${entries}`);
    console.log(`Entries holding a full number: ${needMasking}`);
    console.log(APPLY ? `Entries masked: ${masked}` : 'Dry run: nothing written. Run again with --apply to mask them.');
}

run()
    .catch((err) => {
        console.error('Masking failed:', err.message);
        process.exitCode = 1;
    })
    .finally(() => mongoose.connection.close());
