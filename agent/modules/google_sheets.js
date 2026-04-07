const { google } = require("googleapis");
const logger = require("../utils/logger");
const config = require("../utils/config");

// Queue for serializing Google Sheets writes to prevent race conditions
const writeQueues = new Map();

class GoogleSheetsService {
  constructor() {
    this.sheetsClient = null;
    this.isAuthenticated = false;
    this.credentials = null;
  }

  /**
   * Authenticate using the Service Account JSON file stored in the agent directory
   */
  async authenticate() {
    if (this.isAuthenticated) return true;

    try {
      if (!config.google.clientEmail || !config.google.privateKey) {
        logger.error("Google Sheets credentials missing in config");
        return false;
      }

      const auth = new google.auth.GoogleAuth({
        credentials: {
          client_email: config.google.clientEmail,
          private_key: config.google.privateKey,
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });

      this.sheetsClient = google.sheets({ version: "v4", auth });
      this.isAuthenticated = true;
      logger.info(
        "Authenticated with Google Sheets API using environment variables",
      );
      return true;
    } catch (error) {
      logger.error("Failed to authenticate with Google Sheets", {
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Ensure a sheet (tab) exists within the spreadsheet.
   * If it doesn't exist, create it.
   */
  async ensureSheetExists(spreadsheetId, sheetName) {
    if (!(await this.authenticate())) return false;

    try {
      const spreadsheet = await this.sheetsClient.spreadsheets.get({
        spreadsheetId,
      });

      const sheetExists = spreadsheet.data.sheets.some(
        (s) => s.properties.title === sheetName,
      );

      if (!sheetExists) {
        logger.info(
          `Creating new sheet (tab): ${sheetName} in spreadsheet ${spreadsheetId}`,
        );
        await this.sheetsClient.spreadsheets.batchUpdate({
          spreadsheetId,
          resource: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: sheetName,
                  },
                },
              },
            ],
          },
        });

        // Add headers for the new sheet
        const headers = [
          [
            "User",
            "Role",
            "Hospital Name",
            "Location",
            "Salary",
            "Posted Date",
            "Apply Link",
            "Source URL",
            "Scraped At",
            "Contact Email",
            "Contact Phone",
          ],
        ];
        await this.appendData(spreadsheetId, sheetName, headers);
      }

      return true;
    } catch (error) {
      logger.error(`Error ensuring sheet ${sheetName} exists`, {
        error: error.message,
        status: error.response?.status,
        details: error.response?.data?.error?.message || error.response?.data
      });
      return false;
    }
  }

  /**
   * Append rows of data to a specific sheet (tab)
   */
  async appendData(spreadsheetId, sheetName, rows) {
    if (!(await this.authenticate())) return false;

    try {
      const range = `'${sheetName}'!A1`;
      await this.sheetsClient.spreadsheets.values.append({
        spreadsheetId,
        range: range,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        resource: {
          values: rows,
        },
      });
      logger.info(
        `Appended ${rows.length} rows to sheet: '${sheetName}' (Range: ${range})`,
      );
      return true;
    } catch (error) {
      logger.error(`Failed to append data to sheet ${sheetName}`, {
        error: error.message,
        status: error.response?.status,
        details: error.response?.data?.error?.message || error.response?.data
      });
      return false;
    }
  }

  /**
   * Save jobs to Google Sheets using a global queue to prevent race conditions.
   * This is the main entry point for saving jobs from the agent.
   * 
   * @param {string} username - The username to identify who saved the job
   * @param {Array} jobs - Array of job objects
   */
  async saveJobsToUserExcel(username, jobs) {
    if (!username || !jobs || jobs.length === 0) {
      logger.info('No jobs to save - empty username or jobs array');
      return;
    }

    // Use a single global key for the shared sheet
    const queueKey = "shared_sheets_write_lock";

    // Get or create queue for global access
    if (!writeQueues.has(queueKey)) {
      writeQueues.set(queueKey, Promise.resolve());
    }

    // Enqueue the write operation — bind `this` explicitly so it's not lost in the promise chain
    const self = this;
    const currentQueue = writeQueues.get(queueKey);
    const nextQueue = currentQueue.then(async () => {
      try {
        if (config.google && config.google.sheetId) {
          const sheetName = "All_Jobs";
          logger.info(`Saving ${jobs.length} jobs to Google Sheets tab: ${sheetName}`);
          await self.saveJobsToSheet(config.google.sheetId, sheetName, jobs, username);
        } else {
          logger.warn('Google Sheets not configured - jobs will not be saved');
        }
      } catch (error) {
        logger.error(`Error in Google Sheets write queue`, {
          error: error.message,
        });
      }
    });

    // Update queue reference
    writeQueues.set(queueKey, nextQueue);

    // Return the promise so caller can await if needed
    return nextQueue;
  }

  /**
   * Get all existing source_urls already in the sheet to avoid duplicates
   */
  async getExistingSourceUrls(spreadsheetId, sheetName) {
    try {
      const response = await this.sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetName}'!H:H`, // Column H = source_url
      });
      const rows = response.data.values || [];
      // Skip header row, collect all source_urls into a Set for O(1) lookup
      return new Set(rows.slice(1).map(r => r[0]).filter(Boolean));
    } catch (error) {
      logger.warn('Could not fetch existing source URLs from sheet', { error: error.message });
      return new Set();
    }
  }

  /**
   * Internal method to save jobs to a specific sheet — skips already-existing source_urls
   * @param {string} spreadsheetId - The Google Sheets spreadsheet ID
   * @param {string} sheetName - The target tab name (e.g., "All_Jobs")
   * @param {Array} jobs - Array of job objects
   * @param {string} username - The username to record
   */
  async saveJobsToSheet(spreadsheetId, sheetName, jobs, username) {
    try {
      if (!spreadsheetId) {
        logger.warn('Google Sheets spreadsheet ID not configured');
        return;
      }

      logger.info(
        `Attempting to save ${jobs.length} jobs to Google Sheets. Tab: "${sheetName}", SpreadSheetID: ${spreadsheetId}`,
      );

      // Ensure the tab exists
      const exists = await this.ensureSheetExists(spreadsheetId, sheetName);
      if (!exists) {
        throw new Error(`Could not ensure sheet tab ${sheetName} exists`);
      }

      // Fetch existing source_urls to deduplicate
      const existingUrls = await this.getExistingSourceUrls(spreadsheetId, sheetName);
      const newJobs = jobs.filter(job => !job.source_url || !existingUrls.has(job.source_url));

      if (newJobs.length === 0) {
        logger.info(`All ${jobs.length} jobs already exist in sheet — skipping write`);
        return;
      }

      logger.info(`Writing ${newJobs.length} new jobs (skipped ${jobs.length - newJobs.length} duplicates)`);

      // Prepare data rows
      const rows = newJobs.map((job) => [
        username || "Unknown",
        job.role || "",
        job.hospital_name || "",
        job.location || "",
        job.salary || "",
        job.posted_date || "",
        job.apply_link || "",
        job.source_url || "",
        job.scraped_at
          ? new Date(job.scraped_at).toISOString()
          : new Date().toISOString(),
        job.emails ? job.emails.join(", ") : "",
        job.phones ? job.phones.join(", ") : "",
      ]);

      await this.appendData(spreadsheetId, sheetName, rows);
      logger.info(`Successfully saved ${newJobs.length} jobs to Google Sheets tab: ${sheetName}`);
    } catch (error) {
      logger.error(`Failed to save to Google Sheets tab ${sheetName}`, {
        error: error.message,
      });
      throw error;
    }
  }
}

module.exports = new GoogleSheetsService();
