// One-time clean-up of Aadhaar numbers stored before masking was added
// (UIDAI rules). New uploads are masked and redacted when saved; this covers
// the ones from before.
//
// 1. Stored data: masks every Aadhaar number in Aadhaar entries' extractedText,
//    extractedData and verificationMeta.rawResponse to its last 4 digits.
// 2. With --images: blacks out the first 8 digits on the stored card files
//    in S3 (same redaction as new uploads) and overwrites them in place.
//
// Safe to re-run: masked values and redacted files are skipped.
//
// Usage (from backend/):
//   node scripts/maskAadhaarNumbers.js                     dry run: counts only, writes nothing
//   node scripts/maskAadhaarNumbers.js --apply             masks stored data
//   node scripts/maskAadhaarNumbers.js --apply --images    also redacts the stored card files
//
// Prints counts and document ids only, never a number or a name. If the S3
// bucket keeps old versions, delete the noncurrent versions of the redacted
// files afterwards, or the originals stay retrievable.
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const connectDB = require('../src/config/database');
const Document = require('../src/models/Document');
const { maskedEntryFields } = require('../src/utils/aadhaarMask');

const APPLY = process.argv.includes('--apply');
const IMAGES = process.argv.includes('--images');

async function redactStoredFile(entry) {
    const { getObjectBuffer, uploadToS3 } = require('../src/services/s3.service');
    const { redact } = require('../src/services/aadhaarRedaction.service');
    const FileType = require('file-type');
    const original = await getObjectBuffer(entry.s3Key);
    const type = await FileType.fromBuffer(original);
    const result = await redact(original, type?.mime || 'application/octet-stream');
    await uploadToS3(result.buffer, entry.s3Key, result.mimetype);
}

async function run() {
    await connectDB();
    const cursor = Document.find({ 'documents.documentType': 'aadhaar-card' })
        .select('documents._id documents.documentType documents.s3Key documents.imageRedactedAt documents.extractedText documents.extractedData documents.verificationMeta')
        .lean()
        .cursor();

    const counts = { records: 0, entries: 0, needMasking: 0, masked: 0, filesToRedact: 0, filesRedacted: 0 };
    const couldNotRedact = [];

    for await (const record of cursor) {
        counts.records++;
        for (const entry of record.documents || []) {
            if (entry.documentType !== 'aadhaar-card') continue;
            counts.entries++;

            const changes = maskedEntryFields(entry);
            if (changes) {
                counts.needMasking++;
                if (APPLY) {
                    const $set = {};
                    for (const [path, value] of Object.entries(changes)) $set[`documents.$[entry].${path}`] = value;
                    // Raw update on purpose: only these fields, no hooks or timestamps
                    const result = await Document.collection.updateOne(
                        { _id: record._id },
                        { $set },
                        { arrayFilters: [{ 'entry._id': entry._id }] }
                    );
                    counts.masked += result.modifiedCount;
                }
            }

            if (entry.s3Key && !entry.imageRedactedAt) {
                counts.filesToRedact++;
                if (APPLY && IMAGES) {
                    try {
                        await redactStoredFile(entry);
                        await Document.collection.updateOne(
                            { _id: record._id },
                            { $set: { 'documents.$[entry].imageRedactedAt': new Date() } },
                            { arrayFilters: [{ 'entry._id': entry._id }] }
                        );
                        counts.filesRedacted++;
                    } catch (err) {
                        couldNotRedact.push(`${entry._id} (${err.constructor.name})`);
                    }
                }
            }
        }
    }

    console.log(`Records with an Aadhaar: ${counts.records}`);
    console.log(`Aadhaar entries: ${counts.entries}`);
    console.log(`Entries holding a full number: ${counts.needMasking}${APPLY ? `, masked: ${counts.masked}` : ''}`);
    console.log(`Card files not yet redacted: ${counts.filesToRedact}${APPLY && IMAGES ? `, redacted: ${counts.filesRedacted}` : ''}`);
    if (couldNotRedact.length) {
        console.log(`Card files that could not be redacted (${couldNotRedact.length}); ask these users to upload again, or delete the files:`);
        for (const line of couldNotRedact) console.log(`  document entry ${line}`);
    }
    if (!APPLY) console.log('Dry run: nothing written. Run again with --apply (and --images for the card files).');
}

run()
    .catch((err) => {
        console.error('Masking failed:', err.message);
        process.exitCode = 1;
    })
    .finally(() => mongoose.connection.close());
