import { Pool } from "pg";
import dotenv from "dotenv";
import { decryptToken } from "./encryption";
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
  const queryText = `s
    INSERT INTO "WarmupEmailLogs" ("id", "warmupId", "recipientEmail", "status", "sentAt")
    VALUES (gen_random_uuid(), $1, $2, $3, NOW())
  `;
  const values = [warmupId, recipientEmail, status];

  await query(queryText, values);
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
  // TODO: add zod validation
  let topMatch = result.rows[0] as EmailCredentials;
  if (!topMatch || !topMatch.password) return null;

  // Decrypt the password
  const secretKey = process.env.ENCRYPTION_SECRET;
  if(!secretKey){
    throw new Error("ENCRYPTION_SECRET is required");
  }
  const password = decryptToken(topMatch.password, secretKey);

  topMatch.password = password;
  return topMatch;
}
