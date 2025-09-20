import pg from "pg";
import dotenv from "dotenv";
import fs from "fs";
import Logger from "../logger";
import { decryptToken } from "./encryption";

const { Pool } = pg;
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    ca: fs.readFileSync("certs/us-east-1-bundle.pem"),
  },
});

export const query = async (text: string, params: (string | number)[]) => {
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (error) {
    console.error(error);
    throw error;
  }
};

export default pool;

// ===============================================================================================
// MARK: =================================== Helper functions ====================================
// ===============================================================================================

/**
 * Helper function to log email response in the database
 * @param warmupId A Unique primary key for the warmup Table
 * @param recipientEmail Email address of the client(person receiving the replied email)
 * @param status Status of the email "REPLIED" | "SPAM" | "SENT"
 */
export async function logEmailResponse(
  warmupId: string,
  recipientEmail: string,
  status: "REPLIED" | "IN_SPAM" | "SENT"
): Promise<void> {
  try {
    const queryText = `
      INSERT INTO "WarmupEmailLogs" ("id", "warmupId", "recipientEmail", "status", "sentAt")
      VALUES (gen_random_uuid(), $1, $2, $3, NOW())
    `;
    const values = [warmupId, recipientEmail, status];

    await query(
      queryText,
      values.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))
    );
    console.log(
      `[LogEmailResponse] Successfully logged ${status} for ${recipientEmail}`
    );
  } catch (error) {
    console.error(
      `[LogEmailResponse] Error logging email response for ${recipientEmail}:`,
      error
    );
    throw error; // Re-throw to be caught by the calling function
  }
}
type EmailCredentials = {
  emailId: string;
  service: "gmail";
  password: string;
  accessToken?: string;
  refreshToken?: string;
};
export async function getEmailCredentials(serviceEmailId: string) {
  const queryText = `SELECT * FROM "WarmupEmailServiceEmailCredential" WHERE "emailId" = $1`;
  const values = [serviceEmailId];

  const result = await query(queryText, values);
  let topMatch = result.rows[0] as EmailCredentials;
  if (!topMatch || !topMatch.password) return null;

  // Decrypt the password
  const secretKey = process.env.ENCRYPTION_SECRET;
  if (!secretKey) {
    Logger.criticalError(
      "[GetEmailCredentials] ENCRYPTION_SECRET is required",
      {
        action: "Getting Email Credentials",
        emailId: serviceEmailId,
      },
      ["Check if the ENCRYPTION_SECRET is correctly defined"]
    );
    throw new Error("ENCRYPTION_SECRET is required");
  }

  // Decrypt password
  const password = decryptToken(topMatch.password, secretKey);
  topMatch.password = password;

  // Decrypt Gmail OAuth tokens if they exist
  if (topMatch.accessToken) {
    try {
      topMatch.accessToken = decryptToken(topMatch.accessToken, secretKey);
      Logger.info(
        `[GetEmailCredentials] Decrypted Gmail access token for ${serviceEmailId}`
      );
    } catch (error) {
      Logger.error(
        "[GetEmailCredentials] Failed to decrypt Gmail access token",
        {
          emailId: serviceEmailId,
          error,
        }
      );
      topMatch.accessToken = undefined;
    }
  }

  if (topMatch.refreshToken) {
    try {
      topMatch.refreshToken = decryptToken(topMatch.refreshToken, secretKey);
      Logger.info(
        `[GetEmailCredentials] Decrypted Gmail refresh token for ${serviceEmailId}`
      );
    } catch (error) {
      Logger.error(
        "[GetEmailCredentials] Failed to decrypt Gmail refresh token",
        {
          emailId: serviceEmailId,
          error,
        }
      );
      topMatch.refreshToken = undefined;
    }
  }

  console.log("Credentials for emailId:", serviceEmailId, {
    emailId: topMatch.emailId,
    service: topMatch.service,
    hasPassword: !!topMatch.password,
    hasAccessToken: !!topMatch.accessToken,
    hasRefreshToken: !!topMatch.refreshToken,
  });

  return topMatch;
}

/**
 * Helper function to save Gmail OAuth tokens to the database
 * @param emailId The email ID to update
 * @param accessToken The access token (will be encrypted)
 * @param refreshToken The refresh token (will be encrypted)
 */
export async function saveGmailOAuthTokens(
  emailId: string,
  accessToken: string,
  refreshToken: string
): Promise<void> {
  try {
    const secretKey = process.env.ENCRYPTION_SECRET;
    if (!secretKey) {
      throw new Error("ENCRYPTION_SECRET is required");
    }

    // Import encryption function
    const { encryptToken } = await import("./encryption");

    // Encrypt the tokens
    const encryptedAccessToken = encryptToken(accessToken, secretKey);
    const encryptedRefreshToken = encryptToken(refreshToken, secretKey);

    const queryText = `
      UPDATE "WarmupEmailServiceEmailCredential" 
      SET "accessToken" = $1, "refreshToken" = $2
      WHERE "emailId" = $3
    `;
    const values = [encryptedAccessToken, encryptedRefreshToken, emailId];

    const result = await query(queryText, values);

    if (result.rowCount === 0) {
      throw new Error(`No email credential found for emailId: ${emailId}`);
    }

    Logger.info(
      `[SaveGmailOAuthTokens] Successfully saved OAuth tokens for ${emailId}`
    );
  } catch (error) {
    Logger.criticalError(
      "[SaveGmailOAuthTokens] Error saving Gmail OAuth tokens",
      {
        action: "Save Gmail OAuth Tokens",
        emailId: emailId,
        error: error,
      },
      ["Check if emailId exists in database", "Verify encryption setup"]
    );
    throw error;
  }
}

/**
 * Helper function to update Gmail access token in the database
 * @param emailId The email ID to update
 * @param accessToken The new access token (will be encrypted)
 */
export async function updateGmailAccessToken(
  emailId: string,
  accessToken: string
): Promise<void> {
  try {
    const secretKey = process.env.ENCRYPTION_SECRET;
    if (!secretKey) {
      throw new Error("ENCRYPTION_SECRET is required");
    }

    // Import encryption function
    const { encryptToken } = await import("./encryption");

    // Encrypt the token
    const encryptedAccessToken = encryptToken(accessToken, secretKey);

    const queryText = `
      UPDATE "WarmupEmailServiceEmailCredential" 
      SET "accessToken" = $1
      WHERE "emailId" = $2
    `;
    const values = [encryptedAccessToken, emailId];

    const result = await query(queryText, values);

    if (result.rowCount === 0) {
      throw new Error(`No email credential found for emailId: ${emailId}`);
    }

    Logger.info(
      `[UpdateGmailAccessToken] Successfully updated access token for ${emailId}`
    );
  } catch (error) {
    Logger.error("[UpdateGmailAccessToken] Error updating Gmail access token", {
      action: "Update Gmail Access Token",
      emailId: emailId,
      error: error,
    });
    throw error;
  }
}

type Issue = {
  title: string;
  description: string;
  priority: "LOW" | "MEDIUM" | "HIGH";
  probableCauses: string[];
  context: Record<string, unknown>;
};
export async function CreateIssueInDB(issue: Issue): Promise<void> {
  try {
    const queryText = `
      INSERT INTO "Issue" ("id","title", "description","service", "priority", "probableCause", "context")
    VALUES (gen_random_uuid(),$1, $2, $3, $4, $5, $6)
  `;
    const values = [
      issue.title,
      issue.description,
      "Warmup",
      issue.priority,
      issue.probableCauses,
      issue.context,
    ];

    // @ts-expect-error - This is a valid query and should not throw an error
    await query(queryText, values);
  } catch (error) {
    console.error("Error creating issue in database:", error);
  }
}
