/**
 * CONVERTED TO COMMONJS for backend compatibility
 */
/**
 * Extractor Module - Gemini API integration for structured data extraction
 *
 * UPDATED: Supports batch processing (3-5 docs per LLM call) and snippet-only extraction
 */
const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require("../utils/config");
const { logger, costTracker } = require("../utils/logger");

// Initialize Gemini client
let genAI = null;

// Available models for fallback
const MODELS = [
  "gemini-2.5-flash-lite", // Fast, cost-efficient, high free-tier quota
  "gemini-2.5-flash",      // Fallback - balanced speed/quality
];

/**
 * Get Gemini model instance
 */
function getModel(modelName = MODELS[0]) {
  if (!genAI) {
    genAI = new GoogleGenerativeAI(config.geminiApiKey);
  }
  return genAI.getGenerativeModel({ model: modelName });
}

// Regex patterns for contact extraction
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_PATTERN = /(?:\+91[-\s]?)?[6-9]\d{9}|\d{2,4}[-\s]?\d{6,8}/g;
const WHATSAPP_PATTERN = /(?:wa\.me\/|whatsapp[:\s]+)[\d\s+-]+/gi;

// URL patterns that are NOT real job apply links
const BAD_URL_PATTERNS = [
    'google.com/search', 'google.co.in/search',
    'google.com/webhp', 'google.co.in/webhp',
    'threads.net', 'instagram.com', 'twitter.com', 'x.com/search',
    'facebook.com/groups', 'reddit.com',
];
const IGNORED_EXTS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];

function isValidApplyUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    if (BAD_URL_PATTERNS.some(p => lower.includes(p))) return false;
    let decoded = lower;
    try { decoded = decodeURIComponent(lower); } catch (e) { /* ignore */ }
    if (IGNORED_EXTS.some(ext => decoded.endsWith(ext) || decoded.includes(ext + '?'))) return false;
    return true;
}

function stripHtml(text) {
    if (!text) return null;
    return text
        .replace(/<[^>]*>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * Extract contacts directly from text using regex
 * @param {string} text - Text content
 * @returns {Object} { emails: [], phones: [], whatsapp: null }
 */
function extractContactsFromText(text) {
  if (!text) return { emails: [], phones: [], whatsapp: null };

  // Extract emails
  const emailMatches = text.match(EMAIL_PATTERN) || [];
  const emails = [...new Set(emailMatches)]
    .filter((e) => !e.includes("example.com") && !e.includes("domain.com"))
    .slice(0, 5);

  // Extract phones
  const phoneMatches = text.match(PHONE_PATTERN) || [];
  const phones = [...new Set(phoneMatches)]
    .map((p) => {
      const digits = p.replace(/\D/g, "").slice(-10);
      if (digits.length === 10 && /^[6-9]/.test(digits)) {
        return `+91-${digits.slice(0, 3)}-${digits.slice(3)}`;
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, 5);

  // Extract WhatsApp
  const waMatch = text.match(WHATSAPP_PATTERN);
  let whatsapp = null;
  if (waMatch && waMatch[0]) {
    const digits = waMatch[0].replace(/\D/g, "").slice(-10);
    if (digits.length === 10) {
      whatsapp = `+91-${digits.slice(0, 3)}-${digits.slice(3)}`;
    }
  }

  return { emails, phones, whatsapp };
}

/**
 * Create batch extraction prompt for multiple documents
 * @param {Object[]} documents - Array of { url, text, title, snippet }
 * @param {string} role - Job role being searched
 * @param {string} location - Location being searched
 * @returns {string} Prompt for Gemini
 */
function createBatchExtractionPrompt(documents, role, location) {
  const docsText = documents
    .map((doc, i) => {
      const content = doc.text || doc.snippet || "";
      return `
--- DOCUMENT ${i + 1} ---
URL: ${doc.url}
Title: ${doc.title || "N/A"}
Content:
${content.slice(0, 15000)}
--- END DOCUMENT ${i + 1} ---`;
    })
    .join("\n\n");

  return `You are a job data extraction expert. Extract job postings for "${role}" in "${location}" from the following ${documents.length} documents.

Return ONLY a valid JSON array (no markdown, no explanations):
[
  {
    "source_index": 0,
    "hospital_name": "company/hospital name",
    "role": "job title",
    "location": "city, state",
    "emails": ["emails found"],
    "phones": ["phones in +91-XXX-XXXXXXX format"],
    "whatsapp": "whatsapp number or null",
    "hr_contact": "HR person name or null",
    "salary": "salary text or null",
    "salary_min": 15000,
    "salary_max": 30000,
    "job_description": "brief description max 200 chars",
    "apply_link": "application URL or null",
    "posted_date": "date or null",
    "urgency": "urgent|immediate|normal",
    "shift_type": "day|night|rotational|flexible",
    "experience_level": "fresher|1-2 years|3-5 years|5+ years",
    "confidence_score": 0-100
  }
]

SOFT ATTRIBUTE RULES:
- urgency: "urgent" if contains urgent/immediate/ASAP/walk-in today, "immediate" if within a week, else "normal"
- salary_min/max: Parse numbers from salary text (e.g., "15000-30000" → min:15000, max:30000). Use null if not found. Assume monthly in INR.
- shift_type: "day", "night", "rotational" (if rotating), or "flexible"
- experience_level: "fresher" (0-1 yr), "1-2 years", "3-5 years", "5+ years"

RULES:
1. source_index = document number (0-based) where job was found
2. Extract up to 3 jobs per document, 10 total max
3. Normalize phones to +91-XXX-XXXXXXX format
4. confidence_score: +30 email, +25 phone, +20 whatsapp, +15 description, +10 salary
5. Only extract jobs matching role "${role}" near "${location}"
6. Return [] if no relevant jobs found

DOCUMENTS:
${docsText}`;
}

/**
 * Create prompt to refine Google Jobs data
 */
function createGoogleJobsExtractionPrompt(jobs, role, location) {
  const jobsText = jobs
    .map(
      (job, i) => `
--- JOB ${i} ---
Title: ${job.role}
Company: ${job.company_name}
Location: ${job.location}
Description:
${(job.job_description || "").slice(0, 3000)}
--- END JOB ${i} ---`,
    )
    .join("\n\n");

  return `Analyse the following job listings for "${role}" in "${location}".
They come from Google Jobs. Your goal is to EXTRACT HIDDEN CONTACT DETAILS from the description and STANDARDIZE the data.

Return ONLY a valid JSON array:
[
  {
    "source_index": 0,
    "hospital_name": "company name from listing",
    "role": "job title",
    "location": "city, state",
    "emails": ["extracted emails from description"],
    "phones": ["extracted phones from description (+91 format)"],
    "whatsapp": "whatsapp number or null",
    "hr_contact": "HR name found in text or null",
    "salary": "salary if mentioned",
    "salary_min": 15000,
    "salary_max": 30000,
    "job_description": "summary max 200 chars",
    "urgency": "urgent|immediate|normal",
    "shift_type": "day|night|rotational|flexible",
    "experience_level": "fresher|1-2 years|3-5 years|5+ years",
    "confidence_score": 0-100
  }
]

RULES:
1. source_index matches the input JOB index (0-based)
2. Look closer at the description for emails/phones that regex might miss (like "call on", "send cv to")
3. Standardize salary and experience levels
4. confidence_score: Start at 60. Add +20 for email, +15 for phone.

JOBS:
${jobsText}`;
}

/**
 * Create snippet extraction prompt (no fetch needed)
 * @param {Object[]} snippets - Array of SERP results with snippets
 * @param {string} role - Job role
 * @param {string} location - Location
 * @returns {string} Prompt
 */
function createSnippetExtractionPrompt(snippets, role, location) {
  const snippetsText = snippets
    .map((s, i) => `[${i}] ${s.title}\n${s.snippet}\nURL: ${s.url}`)
    .join("\n\n");

  return `Extract job contact info for "${role}" in "${location}" from these search snippets.

Return ONLY a valid JSON array:
[
  {
    "source_index": 0,
    "hospital_name": "company name from snippet",
    "role": "${role}",
    "location": "${location}",
    "emails": ["extracted emails"],
    "phones": ["phones in +91-XXX-XXXXXXX"],
    "whatsapp": "whatsapp or null",
    "salary": "salary if mentioned",
    "apply_link": "URL from snippet",
    "confidence_score": 0-100
  }
]

SNIPPETS:
${snippetsText}`;
}

/**
 * Parse LLM response to JSON
 * @param {string} response - LLM response text
 * @returns {Object[]} Parsed jobs array
 */
function parseResponse(response) {
  try {
    let jsonStr = response.trim();

    // 1. Remove markdown code blocks
    if (jsonStr.startsWith("```json")) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.slice(3);
    }

    // Find the last closing brace/bracket to handle "trailing text"
    const lastBracket = jsonStr.lastIndexOf("]");
    const lastBrace = jsonStr.lastIndexOf("}");

    if (lastBracket !== -1 && lastBracket > lastBrace) {
      jsonStr = jsonStr.substring(0, lastBracket + 1);
    } else if (lastBrace !== -1) {
      // It might be a single object, not an array
      jsonStr = jsonStr.substring(0, lastBrace + 1);
    }

    jsonStr = jsonStr.trim();

    // 2. Attempt standard parse
    try {
      const data = JSON.parse(jsonStr);
      return Array.isArray(data) ? data : [data];
    } catch (e) {
      // 3. If failed, try to repair truncated JSON
      // Common issue: "Unterminated string..." or "Unexpected end of input"
      logger.warn("JSON parse failed, attempting repair", { error: e.message });

      // Very basic repair: Close unclosed string, then close objects/arrays
      // This is a heuristic and won't fix everything, but handles simple truncation

      // If it ends with a quote, it might be an unclosed string
      if (
        !jsonStr.endsWith('"') &&
        !jsonStr.endsWith("}") &&
        !jsonStr.endsWith("]")
      ) {
        jsonStr += '"'; // Close the current string
      }

      // Count validation (crudely)
      const openBraces = (jsonStr.match(/{/g) || []).length;
      const closeBraces = (jsonStr.match(/}/g) || []).length;
      const openBrackets = (jsonStr.match(/\[/g) || []).length;
      const closeBrackets = (jsonStr.match(/]/g) || []).length;

      jsonStr += "}".repeat(openBraces - closeBraces);
      jsonStr += "]".repeat(openBrackets - closeBrackets);

      const repairedData = JSON.parse(jsonStr);
      return Array.isArray(repairedData) ? repairedData : [repairedData];
    }
  } catch (error) {
    logger.warn("Failed to parse LLM response after repair", {
      error: error.message,
      preview: response.slice(0, 200),
    });
    return [];
  }
}

/**
 * Call LLM with retry on different models
 * @param {string} prompt - Prompt to send
 * @returns {Promise<Object[]>} Extracted jobs
 */
async function callLLM(prompt) {
  for (const modelName of MODELS) {
    try {
      const model = getModel(modelName);
      logger.debug(`Calling LLM: ${modelName}`);

      const result = await model.generateContent(prompt);
      const response = result.response;
      const text = response.text();

      // Track tokens
      const usage = response.usageMetadata;
      if (usage) {
        costTracker.addGeminiTokens(
          usage.promptTokenCount,
          usage.candidatesTokenCount,
        );
      }

      return parseResponse(text);
    } catch (error) {
      const isRateLimit = error.message?.includes("429");
      logger.warn(`LLM call failed: ${modelName}`, {
        error: error.message,
        isRateLimit,
      });

      if (!isRateLimit) break; // Only retry on rate limit
    }
  }

  return [];
}

/**
 * Extract jobs from SERP snippets directly (no fetch needed)
 * High-signal snippets that contain contact info can be extracted without fetching the page.
 *
 * @param {Object[]} snippets - SERP results with title, snippet, url, snippetContacts
 * @param {string} role - Job role
 * @param {string} location - Location
 * @returns {Promise<Object[]>} Extracted jobs
 */
async function extractFromSnippets(snippets, role, location) {
  if (!snippets || snippets.length === 0) return [];

  logger.info(`Extracting from ${snippets.length} snippets (no fetch)`);

  // For snippets with already-extracted contacts, create jobs directly
  const directJobs = [];
  const needsLLM = [];

  for (const snippet of snippets) {
    const contacts =
      snippet.snippetContacts || extractContactsFromText(snippet.snippet || "");

    if (
      contacts.emails.length > 0 ||
      contacts.phones.length > 0 ||
      contacts.whatsapp
    ) {
      // Create job directly from snippet
      directJobs.push({
        hospital_name: extractCompanyFromTitle(snippet.title),
        role: role,
        location: location,
        emails: contacts.emails,
        phones: contacts.phones,
        whatsapp: contacts.whatsapp,
        hr_contact: null,
        salary: extractSalaryFromText(snippet.snippet),
        job_description: stripHtml(snippet.snippet?.slice(0, 200)),
        apply_link: isValidApplyUrl(snippet.url) ? snippet.url : null,
        posted_date: null,
        source_url: snippet.url,
        confidence_score: calculateConfidence(contacts),
        extracted_at: new Date().toISOString(),
        extraction_method: "snippet_direct",
      });
    } else {
      needsLLM.push(snippet);
    }
  }

  // Use LLM for snippets without clear contacts
  let llmJobs = [];
  if (needsLLM.length > 0) {
    const prompt = createSnippetExtractionPrompt(needsLLM, role, location);
    const extracted = await callLLM(prompt);

    llmJobs = extracted.map((job) => ({
      ...job,
      source_url: needsLLM[job.source_index]?.url,
      extracted_at: new Date().toISOString(),
      extraction_method: "snippet_llm",
    }));
  }

  const allJobs = [...directJobs, ...llmJobs];
  logger.info(`Snippet extraction completed`, {
    direct: directJobs.length,
    llm: llmJobs.length,
    total: allJobs.length,
  });

  return allJobs;
}

/**
 * Extract jobs from fetched HTML documents in batches
 *
 * @param {Object[]} documents - Array of { url, text, html, title }
 * @param {string} role - Job role
 * @param {string} location - Location
 * @param {number} batchSize - Documents per LLM call (default: 4)
 * @returns {Promise<Object[]>} Extracted jobs
 */
async function extractFromDocuments(
  documents,
  role,
  location,
  batchSize = 4,
  onBatchComplete = null,
) {
  if (!documents || documents.length === 0) return [];

  logger.info(
    `Batch extracting from ${documents.length} documents (batch size: ${batchSize})`,
  );

  const allJobs = [];

  // Process in batches
  for (let i = 0; i < documents.length; i += batchSize) {
    const batch = documents.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(documents.length / batchSize);

    logger.debug(`Processing batch ${batchNum}/${totalBatches}`);

    // Prepare documents for prompt
    const docsForPrompt = batch.map((doc) => ({
      url: doc.url,
      title: doc.title || "",
      text: doc.text || doc.html?.slice(0, 15000) || "",
    }));

    const prompt = createBatchExtractionPrompt(docsForPrompt, role, location);
    const extracted = await callLLM(prompt);

    // Enrich with source URLs and metadata
    const enriched = extracted.map((job) => {
      const sourceDoc = batch[job.source_index] || batch[0];
      return {
        ...job,
        source_url: sourceDoc?.url,
        apply_link: isValidApplyUrl(job.apply_link) ? job.apply_link : (isValidApplyUrl(sourceDoc?.url) ? sourceDoc?.url : null),
        job_description: stripHtml(job.job_description),
        extracted_at: new Date().toISOString(),
        extraction_method: "batch_llm",
      };
    });

    // Fallback contact extraction
    for (const job of enriched) {
      if (
        (!job.emails || job.emails.length === 0) &&
        (!job.phones || job.phones.length === 0)
      ) {
        const sourceDoc = batch.find((d) => d.url === job.source_url);
        if (sourceDoc) {
          const fallback = extractContactsFromText(
            sourceDoc.text || sourceDoc.html || "",
          );
          if (fallback.emails.length > 0) job.emails = fallback.emails;
          if (fallback.phones.length > 0) job.phones = fallback.phones;
          if (fallback.whatsapp) job.whatsapp = fallback.whatsapp;
        }
      }
    }

    allJobs.push(...enriched);

    // Notify progress if callback provided
    if (onBatchComplete && typeof onBatchComplete === "function") {
      try {
        // Determine outreach status for this batch before sending back
        for (const job of enriched) {
          job.emails = job.emails || [];
          job.phones = job.phones || [];
          job.whatsapp = job.whatsapp || null;

          if (calculateConfidence(job) >= 60) job.outreach_status = "ready";
          else if (calculateConfidence(job) >= 30)
            job.outreach_status = "partial";
          else job.outreach_status = "no_direct_outreach";
        }

        const shouldContinue = await onBatchComplete(enriched);
        if (shouldContinue === false) {
          logger.info("Batch processing stopped by callback");
          break;
        }
      } catch (error) {
        logger.error("Error in onBatchComplete callback", {
          error: error.message,
        });
      }
    }

    // Rate limit delay between batches
    if (i + batchSize < documents.length) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  logger.info(`Batch extraction completed`, {
    documents: documents.length,
    llmCalls: Math.ceil(documents.length / batchSize),
    jobsExtracted: allJobs.length,
  });

  return allJobs;
}

/**
 * Unified extraction function - handles both snippets and documents
 * @param {Object} options
 * @param {Object[]} options.snippets - High-signal SERP results
 * @param {Object[]} options.documents - Fetched HTML documents
 * @param {string} options.role - Job role
 * @param {string} options.location - Location
 * @returns {Promise<Object[]>} All extracted jobs
 */
async function extract({
  snippets = [],
  documents = [],
  googleJobs = [],
  role,
  location,
  onBatchComplete = null,
}) {
  const results = [];

  // Extract from Google Jobs (Refinement)
  if (googleJobs.length > 0) {
    const gjJobs = await extractFromGoogleJobs(googleJobs, role, location, 5);
    results.push(...gjJobs);
  }

  // Extract from snippets first (fast, no fetch)
  if (snippets.length > 0) {
    const snippetJobs = await extractFromSnippets(snippets, role, location);
    results.push(...snippetJobs);
  }

  // Extract from fetched documents (batched)
  if (documents.length > 0) {
    const docJobs = await extractFromDocuments(
      documents,
      role,
      location,
      4,
      onBatchComplete,
    );
    results.push(...docJobs);
  }

  // Ensure all jobs have required arrays
  for (const job of results) {
    job.emails = job.emails || [];
    job.phones = job.phones || [];
    job.whatsapp = job.whatsapp || null;

    // Calculate outreach status
    if (job.confidence_score >= 60) {
      job.outreach_status = "ready";
    } else if (job.confidence_score >= 30) {
      job.outreach_status = "partial";
    } else {
      job.outreach_status = "no_direct_outreach";
    }
  }

  return results;
}

/**
 * Refine and extract details from Google Jobs structured data using LLM
 * @param {Object[]} googleJobs - Array of structured jobs from SearchApi
 * @param {string} role - Job role
 * @param {string} location - Location
 * @param {number} batchSize - Batch size (default: 5)
 * @returns {Promise<Object[]>} Enriched jobs
 */
async function extractFromGoogleJobs(
  googleJobs,
  role,
  location,
  batchSize = 5,
) {
  if (!googleJobs || googleJobs.length === 0) return [];

  logger.info(`Refining ${googleJobs.length} Google Jobs via LLM...`);
  const allEnriched = [];

  for (let i = 0; i < googleJobs.length; i += batchSize) {
    const batch = googleJobs.slice(i, i + batchSize);
    const prompt = createGoogleJobsExtractionPrompt(batch, role, location);

    const extracted = await callLLM(prompt);

    // Merge LLM results with original data (LLM is better at contacts/standardization, original is better for links/metadata)
    const enrichedBatch = extracted
      .map((extJob) => {
        const original = batch[extJob.source_index];
        if (!original) return null;

        return {
          ...original, // Keep original links/metadata
          ...extJob, // Override with standardized fields (salary, contacts, standardized role)
          // Clean salary to remove dollar signs
          salary: extJob.salary ? extJob.salary.replace(/^\$\s*/, "") : null,
          // Ensure critical fields are preserved if LLM missed them but original had them
          apply_link: original.apply_link,
          source_url: original.source_url,
          // Strip HTML from description
          job_description: stripHtml(extJob.job_description || original.job_description),
          // Merge contacts
          emails: [
            ...new Set([...(original.emails || []), ...(extJob.emails || [])]),
          ],
          phones: [
            ...new Set([...(original.phones || []), ...(extJob.phones || [])]),
          ],
          extracted_at: new Date().toISOString(),
          extraction_method: "google_jobs_llm",
        };
      })
      .filter(Boolean);

    allEnriched.push(...enrichedBatch);

    // Rate limit
    if (i + batchSize < googleJobs.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return allEnriched;
}

// Helper functions
function extractCompanyFromTitle(title) {
  if (!title) return null;
  // Remove common suffixes
  return title
    .replace(/\s*[-–|]\s*(Jobs|Careers|Hiring|Recruitment).*$/i, "")
    .replace(/\s*\(.*\)\s*$/, "")
    .trim()
    .slice(0, 100);
}

function extractSalaryFromText(text) {
  if (!text) return null;
  const match = text.match(
    /(?:Rs\.?|₹|INR|\$)\s*[\d,]+(?:\s*-\s*[\d,]+)?(?:\s*(?:per month|p\.m\.|monthly|LPA|lakh))?/i,
  );
  const salary = match ? match[0] : null;
  // Remove leading dollar sign if present
  return salary ? salary.replace(/^\$\s*/, "") : null;
}

function calculateConfidence(contacts) {
  let score = 0;
  if (contacts.emails?.length > 0) score += 30;
  if (contacts.phones?.length > 0) score += 25;
  if (contacts.whatsapp) score += 20;
  return score;
}

module.exports = {
  extract,
  extractFromSnippets,
  extractFromDocuments,
  extractFromGoogleJobs,
  extractContactsFromText,
  callLLM,
  parseResponse,
  isValidApplyUrl,
  stripHtml,
};
// module.exports = extract;