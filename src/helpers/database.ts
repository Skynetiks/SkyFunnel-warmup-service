import { Pool } from "pg";
import dotenv from "dotenv";
import { decryptToken } from "./encryption";
import Logger from "../logger";
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const query = async (text: string, params: (string | number)[]) => {
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (error) {
    console.error("Error querying database:", error);
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
  const queryText = `
    INSERT INTO "WarmupEmailLogs" ("id", "warmupId", "recipientEmail", "status", "sentAt")
    VALUES (gen_random_uuid(), $1, $2, $3, NOW())
  `;
  const values = [warmupId, recipientEmail, status];

  await query(
    queryText,
    values.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))
  );
}
type EmailCredentials = {
  emailId: string;
  service: "gmail";
  password: string;
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
  const password = decryptToken(topMatch.password, secretKey);

  topMatch.password = password;
  return topMatch;
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
