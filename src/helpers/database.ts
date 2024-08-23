import { Pool } from "pg";
import dotenv from "dotenv";
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const query = async (text: string, params: (string | number)[]) => {
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (error) {
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
export async function logEmailResponse(warmupId: string, recipientEmail: string, status: "REPLIED" | "SPAM" | "SENT"): Promise<void> {
  const queryText = `
    INSERT INTO email_logs (warmup_id, recipient_email, status)
    VALUES ($1, $2, $3)
  `;
  const values = [warmupId, recipientEmail, status];

  await query(queryText, values);
}
