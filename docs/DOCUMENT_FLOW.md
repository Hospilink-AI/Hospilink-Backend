# Document Upload & Verification Flow

## Overview

The document management system handles document uploads, verification, and retrieval for staff and hospital users. Documents are stored in AWS S3 with metadata in MongoDB, featuring OCR extraction, verification workflows, and secure pre-signed URL access.

---

## Architecture

```
Client → API Routes → Controller → Service → S3 + MongoDB
                                          ↓
                                    OCR + Parsers
```

**Key Components:**
- **Model**: `backend/src/models/Document.js`
- **Routes**: `backend/src/routes/document.routes.js`
- **Controller**: `backend/src/controllers/document.controller.js`
- **Service**: `backend/src/services/document.service.js`
- **Storage**: AWS S3 (files) + MongoDB (metadata)

---

## Data Model

### Document Schema

```javascript
{
  userId: ObjectId,              // Reference to User
  userRole: "staff" | "hospital", // Only these roles can upload
  documents: [
    {
      _id: ObjectId,
      documentType: String,      // See allowed types below
      s3Key: String,             // S3 storage path
      fileName: String,
      extractedText: String,     // Raw OCR output
      extractedData: Object,     // Parsed structured data
      isDeleted: Boolean,
      uploadedAt: Date,
      updatedAt: Date,
      verificationStatus: "pending" | "verified" | "rejected" | 
                         "auto-verified" | "manual-pending-verification",
      verifiedBy: ObjectId,      // Admin who verified/rejected
      verifiedAt: Date,
      rejectionReason: String,
      hypervergeData: Object     // KYC verification data
    }
  ],
  timestamps: true
}
```

### Allowed Document Types

**Staff Documents:**
- `aadhaar-card`
- `pan-card`
- `degree-certificate`
- `mcim-certificate` (Medical Council of India - Male)
- `ncim-certificate` (Nursing Council of India - Male)
- `license-permit`
- `resume-experience`
- `recommendation-letter`
- `live-picture`
- `Other`

**Hospital Documents:**
- `cin-certificate` (Corporate Identification Number)
- `gst-certificate`
- `nabh-certificate` (National Accreditation Board for Hospitals)
- `rohini-certificate`
- `cghs-certificate` (Central Government Health Scheme)
- `registration-certificate`
- `Other`

### Extracted Data Schemas

Varies by document type:

```javascript
// aadhaar-card
{ name, dob, gender, aadhaarNumber, address }

// pan-card
{ name, dob, panNumber }

// mcim-certificate / ncim-certificate
{ doctorName, registrationNumber }

// cin-certificate
{ businessName, cin, incorporationDate }

// gst-certificate
{ legalName, tradeName, businessType, registrationNumber }
```

---

## API Endpoints

### Base URL
```
/api/documents
```

All endpoints require authentication (`protect` middleware).

---

### 1. Upload Documents

**Endpoint:** `POST /api/documents/upload`

**Auth:** Required (staff/hospital only)

**Content-Type:** `multipart/form-data`

**Query Parameters:**
- `replace` (optional): `true` to replace existing document of same type

**Request Body:**
- Multiple files with fieldname = documentType
- Example: `aadhaar-card`, `pan-card`, etc.

**File Validation:**
- Max size: 5MB per file
- Allowed types:
  - `live-picture`: JPG, PNG only
  - `resume-experience`: PDF only
  - Others: PDF, JPG, PNG

**Response:**
```json
{
  "success": true,
  "count": 2,
  "data": [
    {
      "documentType": "aadhaar-card",
      "verificationStatus": "manual-pending-verification",
      "uploadedAt": "2024-03-26T10:00:00Z",
      "s3Key": "documents/medical-staff/user_id/aadhaar-card/timestamp-file.pdf"
    }
  ]
}
```

**Flow:**
1. Validate fieldnames (documentType)
2. Validate file types per document
3. Check for duplicates (unless `replace=true`)
4. Upload to S3: `documents/{role}/{userId}/{documentType}/{timestamp}-{filename}`
5. Run OCR on supported documents
6. Parse extracted text with document-specific parser
7. Set verification status based on extracted data quality
8. Store metadata in MongoDB
9. On failure: rollback all uploaded files from S3

**Error Handling:**
- Partial upload failure triggers S3 cleanup
- All successfully uploaded files are deleted if any upload fails

---

### 2. Get User Documents

**Endpoint:** `GET /api/documents`

**Auth:** Required

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)

**Response:**
```json
{
  "success": true,
  "documents": [
    {
      "documentId": "doc_id",
      "documentType": "aadhaar-card",
      "verificationStatus": "verified",
      "uploadedAt": "2024-03-20T10:00:00Z",
      "updatedAt": "2024-03-21T14:30:00Z",
      "url": "https://s3.amazonaws.com/presigned-url...",
      "extractedData": { "name": "John Doe", "aadhaarNumber": "1234 5678 9012" },
      "fileName": "aadhaar.pdf"
    }
  ],
  "pagination": {
    "totalItems": 25,
    "totalPages": 3,
    "currentPage": 1,
    "itemsPerPage": 10,
    "hasNextPage": true,
    "hasPrevPage": false,
    "nextPage": 2,
    "prevPage": null
  }
}
```

**Notes:**
- Pre-signed URLs expire in 15 minutes
- Only returns non-deleted documents
- Includes extracted structured data

---

### 3. Get Required Documents Status

**Endpoint:** `GET /api/documents/required-status`

**Auth:** Required

**Response:**
```json
{
  "success": true,
  "data": {
    "requiredDocuments": ["aadhaar-card", "pan-card"],
    "conditionalGroups": [["mcim-certificate", "ncim-certificate"]],
    "optionalDocuments": ["resume-experience"],
    "uploadedDocuments": [
      {
        "documentType": "aadhaar-card",
        "verificationStatus": "verified",
        "uploadedAt": "2024-03-20T10:00:00Z",
        "updatedAt": "2024-03-21T14:30:00Z",
        "verifiedAt": "2024-03-21T14:30:00Z",
        "fileName": "aadhaar.pdf"
      },
      {
        "documentType": "mcim-certificate",
        "verificationStatus": "rejected",
        "uploadedAt": "2024-03-22T09:00:00Z",
        "updatedAt": "2024-03-22T15:00:00Z",
        "rejectionReason": "Document text is unclear",
        "fileName": "mcim.pdf"
      }
    ],
    "missingRequired": ["pan-card"],
    "missingConditional": [],
    "isProfileComplete": false
  }
}
```

**Use Case:**
- Profile completion checklist
- Document verification dashboard
- Single API call for full document status

---

### 4. Verify Document (Admin Only)

**Endpoint:** `PUT /api/documents/:documentId/verify`

**Auth:** Required (admin role)

**Response:**
```json
{
  "success": true,
  "message": "Document verified successfully",
  "data": {
    "documentId": "doc_id",
    "documentType": "aadhaar-card",
    "verificationStatus": "verified",
    "verifiedBy": "admin_id",
    "verifiedAt": "2024-03-26T10:30:00Z",
    "userId": "user_id",
    "userName": "John Doe",
    "userEmail": "john@example.com"
  }
}
```

**Notes:**
- Cannot verify already verified documents
- Cannot verify deleted documents
- Returns user info for audit logs and notifications

---

### 5. Reject Document (Admin Only)

**Endpoint:** `PUT /api/documents/:documentId/reject`

**Auth:** Required (admin role)

**Request Body:**
```json
{
  "reason": "Document text is unclear, please re-upload"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "documentId": "doc_id",
    "documentType": "aadhaar-card",
    "verificationStatus": "rejected",
    "rejectionReason": "Document text is unclear, please re-upload",
    "verifiedBy": "admin_id",
    "verifiedAt": "2024-03-26T10:30:00Z",
    "userId": "user_id",
    "userName": "John Doe",
    "userEmail": "john@example.com"
  }
}
```

**Notes:**
- Rejection reason is required
- Cannot reject already verified documents
- Cannot reject deleted documents

---

### 6. Delete Document

**Endpoint:** `DELETE /api/documents/:documentId`

**Auth:** Required (document owner only)

**Response:**
```json
{
  "success": true,
  "message": "Document deleted"
}
```

**Notes:**
- Soft delete (sets `isDeleted: true`)
- Removes file from S3
- Preserves record for audit trail
- Cannot delete already deleted documents

---

## Document Upload Flow

### Step-by-Step Process

```
1. Client uploads file(s)
   ↓
2. Multer middleware (memory storage, 5MB limit, file type check)
   ↓
3. Validation middleware (documentType + file type per doc)
   ↓
4. Controller receives files
   ↓
5. Service processes each file sequentially:
   a. Check for existing document
   b. If replace=true: soft-delete old + remove from S3
   c. Generate S3 key
   d. Upload to S3
   e. Run OCR (if supported)
   f. Parse extracted text
   g. Set verification status
   h. Save to MongoDB
   ↓
6. On error: rollback all S3 uploads
   ↓
7. Return results
```

### S3 Key Structure

```
documents/{role}/{userId}/{documentType}/{timestamp}-{filename}

Examples:
- documents/medical-staff/507f1f77bcf86cd799439011/aadhaar-card/1711449600000-aadhaar.pdf
- documents/hospital/507f1f77bcf86cd799439012/gst-certificate/1711449600000-gst.pdf
```

### Verification Status Flow

```
Upload → OCR → Parse
           ↓
    Has valid data?
      ↓         ↓
     Yes        No
      ↓         ↓
manual-pending  pending
      ↓
   Admin Review
      ↓
  verified / rejected
```

---

## OCR & Data Extraction

### Supported Documents

OCR runs automatically on:
- `aadhaar-card`
- `pan-card`
- `mcim-certificate`
- `ncim-certificate`
- `license-permit`
- `cin-certificate`
- `gst-certificate`
- `nabh-certificate`
- `rohini-certificate`
- `cghs-certificate`

### Parser Locations

```
backend/src/services/parsers/
├── aadhaar.parser.js
├── pan.parser.js
├── mcim.parser.js
├── ncim.parser.js
├── license.parser.js
├── cin.parser.js
├── gst.parser.js
├── nabh.parser.js
├── rohini.parser.js
└── cghs.parser.js
```

### OCR Service

**Location:** `backend/src/services/ocr.service.js`

Uses Tesseract.js for text extraction from PDFs and images.

**Language Support:**
- English (`eng`) - default for all documents
- Hindi (`hin`) - used for Aadhaar cards along with English

**Tesseract Training Data:**
- Tesseract.js automatically downloads required `.traineddata` files on first use
- Files are cached locally but should not be tracked in Git
- Current languages: `eng.traineddata` (5MB), `hin.traineddata` (1.6MB)

**Image Preprocessing:**
- Resize to 1800px width
- Convert to grayscale
- Normalize contrast
- Sharpen edges
- Apply threshold for black & white

---

## Security & Access Control

### Authentication
- All endpoints require JWT token (`protect` middleware)
- Token passed via `Authorization: Bearer <token>` header

### Authorization
- Upload/Get/Delete: Document owner only
- Verify/Reject: Admin role only (`authorize('admin')` middleware)

### File Security
- Files stored in private S3 bucket
- Access via pre-signed URLs (15-minute expiry)
- S3 keys stored in DB, not full URLs

### Validation Layers
1. **Route level**: Document type validation
2. **Middleware level**: File type per document type
3. **Service level**: Business logic validation

---

## Database Indexes

```javascript
// Primary lookup
{ userId: 1 } (unique)

// Fetch specific document type
{ userId: 1, "documents.documentType": 1 }

// Admin dashboard filters
{ "documents.verificationStatus": 1 }
{ userRole: 1, "documents.verificationStatus": 1 }

// Audit trail
{ "documents.verifiedBy": 1 }

// Soft-delete queries
{ userId: 1, "documents.isDeleted": 1 }
```

---

## Error Handling

### Common Errors

**400 Bad Request:**
- No files uploaded
- Invalid document type
- Invalid file type for document
- Missing rejection reason
- Document already uploaded (without replace flag)

**403 Forbidden:**
- Non-admin trying to verify/reject
- User trying to access another user's documents

**404 Not Found:**
- Document not found
- User has no documents

**500 Internal Server Error:**
- S3 upload failure
- OCR processing failure
- Database errors

### Rollback Mechanism

If any upload in a batch fails:
1. All successfully uploaded files are deleted from S3
2. No database records are created
3. User receives clear error message

---

## Configuration

### Environment Variables

```bash
# AWS S3
AWS_REGION=ap-south-1
AWS_BUCKET_NAME=hospilink
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret

# MongoDB
MONGODB_URI=mongodb://localhost:27017/hospilink

# JWT
JWT_SECRET=your_secret_key
```

### Required Documents Config

**Location:** `backend/src/config/requiredDocs.js`

Defines required, conditional, and optional documents per role.

---

## Best Practices

### For Frontend Developers

1. **Upload with replace flag:**
   ```javascript
   POST /api/documents/upload?replace=true
   ```

2. **Handle pre-signed URL expiry:**
   - URLs expire in 15 minutes
   - Refresh by calling GET /api/documents again

3. **Use required-status endpoint:**
   - Single call for complete document checklist
   - Shows uploaded docs + verification status

4. **Pagination:**
   - Default: 10 items per page
   - Adjust with `?page=1&limit=20`

### For Backend Developers

1. **Adding new document types:**
   - Update model enum
   - Add to validation middleware
   - Create parser if OCR needed
   - Update requiredDocs config

2. **Modifying parsers:**
   - Test with real documents
   - Handle OCR errors gracefully
   - Return consistent schema

3. **S3 operations:**
   - Always use try-catch
   - Log errors for debugging
   - Clean up on failures

---

## Testing

### Manual Testing

```bash
# Upload document
curl -X POST http://localhost:5000/api/documents/upload \
  -H "Authorization: Bearer <token>" \
  -F "aadhaar-card=@/path/to/aadhaar.pdf"

# Get documents
curl http://localhost:5000/api/documents?page=1&limit=10 \
  -H "Authorization: Bearer <token>"

# Verify document (admin)
curl -X PUT http://localhost:5000/api/documents/<doc_id>/verify \
  -H "Authorization: Bearer <admin_token>"

# Reject document (admin)
curl -X PUT http://localhost:5000/api/documents/<doc_id>/reject \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Unclear document"}'
```

---

## Troubleshooting

### Common Issues

**1. "Document already uploaded" error**
- Solution: Use `?replace=true` query parameter

**2. Pre-signed URLs not working**
- Check AWS credentials
- Verify S3 bucket permissions
- URLs expire after 15 minutes

**3. OCR extraction fails**
- Check file quality
- Verify Tesseract installation
- Review parser logic

**4. Upload fails mid-batch**
- Check S3 connection
- Verify file size limits
- Review rollback logs

---

## Future Enhancements

- [ ] Add document expiry tracking
- [ ] Implement bulk verification
- [ ] Add document comparison (detect duplicates)
- [ ] Support more document types
- [ ] Improve OCR accuracy with ML models
- [ ] Add document version history
- [ ] Implement real-time verification notifications
- [ ] Add document analytics dashboard

---

## Related Files

- Model: `backend/src/models/Document.js`
- Routes: `backend/src/routes/document.routes.js`
- Controller: `backend/src/controllers/document.controller.js`
- Service: `backend/src/services/document.service.js`
- S3 Service: `backend/src/services/s3.service.js`
- OCR Service: `backend/src/services/ocr.service.js`
- Parsers: `backend/src/services/parsers/*.js`
- Validation: `backend/src/middleware/validation.middleware.js`
- Upload Middleware: `backend/src/middleware/upload.middleware.js`
- Auth Middleware: `backend/src/middleware/auth.middleware.js`
- Pagination Utility: `backend/src/utils/pagination.js`
