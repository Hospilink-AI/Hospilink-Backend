## What and why


## Testing
- [ ] `npm run lint` and `npm test` pass (CI runs both)
- [ ] New behaviour has a test; database behaviour has one in `tests/integration/`

## Checklist
Tick what applies, or say why not.

**Requests**
- [ ] Request bodies are copied field by field (an allowlist), never spread into a model update
- [ ] Ids and filters from the request are cast or validated, so `{ "$ne": null }` and the like can't reach a query
- [ ] User text going into a `$regex` passes through `utils/escapeRegex`

**Access**
- [ ] Every read or change by id checks the caller owns the record, or is an admin with the right capability
- [ ] Status fields (verification, payment, suspension) can only change through their own admin or system flow

**Personal data**
- [ ] No personal data in logs: names, phones, emails, Aadhaar, PAN, OTPs, tokens, coordinates
- [ ] Aadhaar numbers are masked before they're stored

**Data and jobs**
- [ ] Index changes are checked with the real-database test, and existing indexes in Atlas are handled (no silent conflicts)
- [ ] Scheduled jobs handle one bad record without stopping, and report failures through `metrics.cronJobFailed`
- [ ] Responses only add fields; renaming or removing one is agreed with the frontend first
