import express from "express";
import { google } from "googleapis";
import Logger from "./logger";

const app = express();
const PORT = process.env.OAUTH_PORT || 3001;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Gmail OAuth configuration
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI =
  process.env.GMAIL_REDIRECT_URI || "http://localhost:3001/oauth/callback";

if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
  console.error(
    "❌ GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET environment variables are required"
  );
  process.exit(1);
}

// Create OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  REDIRECT_URI
);

// Gmail API scopes
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.readonly",
];

/**
 * Step 1: Generate OAuth2 authorization URL
 */
app.get("/oauth/authorize", (req, res) => {
  try {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline", // Required to get refresh token
      scope: SCOPES,
      prompt: "consent", // Force consent screen to get refresh token
    });

    Logger.info("[OAuth] Generated authorization URL");

    res.json({
      success: true,
      authUrl,
      message: "Visit this URL to authorize the application",
      instructions: [
        "1. Click the authUrl below",
        "2. Sign in with your Gmail account",
        "3. Grant permissions",
        "4. Copy the authorization code from the redirect URL",
        "5. Use the code with POST /oauth/token endpoint",
      ],
    });
  } catch (error) {
    Logger.error("[OAuth] Error generating auth URL", { error });
    res.status(500).json({
      success: false,
      error: "Failed to generate authorization URL",
    });
  }
});

/**
 * Step 2: Exchange authorization code for tokens and save to database
 */
app.post("/oauth/token", async (req, res) => {
  try {
    const { code, emailId } = req.body;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: "Authorization code is required",
      });
    }

    if (!emailId) {
      return res.status(400).json({
        success: false,
        error: "Email ID is required to save tokens to database",
      });
    }

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error("Failed to receive valid tokens from Google");
    }

    // Save tokens to database
    const { saveGmailOAuthTokens } = await import("./helpers/database");
    await saveGmailOAuthTokens(
      emailId,
      tokens.access_token,
      tokens.refresh_token
    );

    Logger.info(
      `[OAuth] Successfully exchanged code for tokens and saved to database for ${emailId}`
    );

    res.json({
      success: true,
      message: "Tokens generated and saved to database successfully",
      data: {
        emailId: emailId,
        tokenInfo: {
          scope: tokens.scope,
          token_type: tokens.token_type,
          expiry_date: tokens.expiry_date,
        },
      },
      instructions: [
        "Tokens have been encrypted and saved to the database",
        "The service will now automatically use Gmail API for this email account",
        "Make sure GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET are set in your .env file",
      ],
    });
  } catch (error) {
    Logger.error("[OAuth] Error exchanging code for tokens", { error });
    res.status(500).json({
      success: false,
      error: "Failed to exchange authorization code for tokens",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * Step 3: Refresh access token using refresh token
 */
app.post("/oauth/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({
        success: false,
        error: "Refresh token is required",
      });
    }

    // Set refresh token
    oauth2Client.setCredentials({
      refresh_token: refresh_token,
    });

    // Refresh access token
    const { credentials } = await oauth2Client.refreshAccessToken();

    Logger.info("[OAuth] Successfully refreshed access token");

    res.json({
      success: true,
      tokens: {
        access_token: credentials.access_token,
        expiry_date: credentials.expiry_date,
        token_type: credentials.token_type,
      },
      message: "Access token refreshed successfully",
      envVariables: {
        GMAIL_ACCESS_TOKEN: credentials.access_token,
      },
    });
  } catch (error) {
    Logger.error("[OAuth] Error refreshing access token", { error });
    res.status(500).json({
      success: false,
      error: "Failed to refresh access token",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * Test endpoint: List Gmail messages using stored tokens
 */
app.get("/gmail/messages", async (req, res) => {
  try {
    const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
    const accessToken = process.env.GMAIL_ACCESS_TOKEN;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        error: "GMAIL_REFRESH_TOKEN environment variable is required",
      });
    }

    // Set credentials
    oauth2Client.setCredentials({
      refresh_token: refreshToken,
      access_token: accessToken,
    });

    // Refresh token if needed
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);

    // Create Gmail API instance
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // List unread messages in inbox
    const response = await gmail.users.messages.list({
      userId: "me",
      q: "in:inbox is:unread",
      maxResults: 10,
    });

    const messages = response.data.messages || [];

    Logger.info(`[Gmail] Found ${messages.length} unread messages`);

    res.json({
      success: true,
      message: `Found ${messages.length} unread messages`,
      data: {
        messageCount: messages.length,
        messages: messages.map((msg) => ({
          id: msg.id,
          threadId: msg.threadId,
        })),
        resultSizeEstimate: response.data.resultSizeEstimate,
      },
    });
  } catch (error) {
    Logger.error("[Gmail] Error listing messages", { error });
    res.status(500).json({
      success: false,
      error: "Failed to list Gmail messages",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * Test endpoint: Check spam emails and mark as not spam
 */
app.post("/gmail/check-spam", async (req, res) => {
  try {
    const { subject } = req.body;

    if (!subject) {
      return res.status(400).json({
        success: false,
        error: "Subject is required",
      });
    }

    const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
    const accessToken = process.env.GMAIL_ACCESS_TOKEN;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        error: "GMAIL_REFRESH_TOKEN environment variable is required",
      });
    }

    // Import and use our Gmail API service
    const { GmailApiService } = await import("./helpers/gmailApi");

    const gmailService = new GmailApiService({
      clientId: GMAIL_CLIENT_ID!,
      clientSecret: GMAIL_CLIENT_SECRET!,
      refreshToken,
      accessToken,
      emailId: subject, // Use subject as temporary emailId for this test
    });

    // Check and fix spam emails
    const result = await gmailService.checkAndFixSpamEmails(subject);

    Logger.info(
      `[Gmail] Spam check result for "${subject}": found=${result.found}, processed=${result.processed}`
    );

    res.json({
      success: true,
      message: result.found
        ? `Found and processed ${result.processed} spam email(s)`
        : "No spam emails found with the specified subject",
      data: {
        found: result.found,
        processed: result.processed,
        subject,
      },
    });
  } catch (error) {
    Logger.error("[Gmail] Error checking spam", { error });
    res.status(500).json({
      success: false,
      error: "Failed to check spam emails",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * OAuth callback handler (for web-based flow)
 */
app.get("/oauth/callback", (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`
      <h1>Authorization Error</h1>
      <p>Error: ${error}</p>
      <p><a href="/oauth/authorize">Try again</a></p>
    `);
  }

  if (code) {
    res.send(`
      <h1>Authorization Successful!</h1>
      <p>Authorization code: <code>${code}</code></p>
      <p>Now make a POST request to <code>/oauth/token</code> with this code and your email ID to save tokens to database.</p>
      <h3>Example:</h3>
      <pre>
curl -X POST http://localhost:${PORT}/oauth/token \\
  -H "Content-Type: application/json" \\
  -d '{"code": "${code}", "emailId": "your-gmail@gmail.com"}'
      </pre>
      <p><strong>Note:</strong> Replace "your-gmail@gmail.com" with the actual email address from your database.</p>
    `);
  } else {
    res.status(400).send(`
      <h1>No Authorization Code</h1>
      <p><a href="/oauth/authorize">Start authorization flow</a></p>
    `);
  }
});

/**
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Gmail OAuth server is running",
    endpoints: {
      "GET /oauth/authorize": "Generate authorization URL",
      "POST /oauth/token": "Exchange code for tokens",
      "POST /oauth/refresh": "Refresh access token",
      "GET /gmail/messages": "List Gmail messages (test)",
      "POST /gmail/check-spam": "Check and fix spam emails",
      "GET /oauth/callback": "OAuth callback handler",
    },
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Gmail OAuth server running on http://localhost:${PORT}`);
  console.log(
    `📝 Visit http://localhost:${PORT}/health for available endpoints`
  );
  console.log(`🔐 Start OAuth flow: http://localhost:${PORT}/oauth/authorize`);
});

export default app;
