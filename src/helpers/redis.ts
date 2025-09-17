import { Redis } from "ioredis";

let connection: Redis | null = null;
export async function getRedisConnection() {
  if (process.env.REDIS_URL && !connection) {
    connection = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    connection.on("error", function (err) {
      connection = null;
    });
  }
  return connection;
}

export async function getRedisKeyValue(key: string): Promise<string | null> {
  const redis = await getRedisConnection();
  if (!redis) {
    console.error("Redis connection not available");
    return null;
  }

  try {
    const value = await redis.get(key);
    return value;
  } catch (error) {
    console.error("Error fetching Redis key:", error);
    return null;
  }
}

export async function setRedisKeyValue(
  key: string,
  value: string,
  expiry: number
): Promise<boolean> {
  const redis = await getRedisConnection();
  if (!redis) {
    console.error("Redis connection not available");
    return false;
  }

  try {
    if (expiry > 0) {
      await redis.set(key, value, "EX", expiry);
    } else {
      await redis.set(key, value);
    }
    return true;
  } catch (error) {
    console.error("Error setting Redis key:", error);
    return false;
  }
}

export async function deleteRedisKey(key: string): Promise<boolean> {
  const redis = await getRedisConnection();
  if (!redis) {
    console.error("Redis connection not available");
    return false;
  }

  try {
    await redis.del(key);
    return true;
  } catch (error) {
    console.error("Error deleting Redis key:", error);
    return false;
  }
}

const EMAIL_BATCH_PREFIX = "email_batch:";
const ONE_HOUR_IN_SECONDS = 60 * 60; // 1 hour (fixed from 10 minutes)

/**
 * Add email to processing batch for the current hour
 */
export async function addEmailToBatch(
  replyFromEmail: string,
  messageData: any
): Promise<boolean> {
  const currentHour = Math.floor(Date.now() / (1000 * 60 * 60)); // Current hour timestamp
  const key = `${EMAIL_BATCH_PREFIX}${currentHour}`;

  const redis = await getRedisConnection();
  if (!redis) {
    console.error("Redis connection not available");
    return false;
  }

  try {
    // Create a unique key combining replyFrom and to emails
    const uniqueKey = `${replyFromEmail}->${messageData.to}`;

    // Get existing messages for this unique combination, if any
    const existingData = await redis.hget(key, uniqueKey);

    if (existingData) {
      // If a message already exists for this replyFrom->to combination in this hour, skip adding the duplicate
      console.log(
        `[AddEmailToBatch] Skipping duplicate message for ${uniqueKey} - already exists in current hour batch`
      );
      return true; // Return true to indicate "success" (message handled, just skipped)
    }

    // No existing message, add the new message with the unique key
    await redis.hset(key, uniqueKey, JSON.stringify(messageData));
    await redis.expire(key, 2 * ONE_HOUR_IN_SECONDS);
    return true;
  } catch (error) {
    console.error("Error adding email to batch:", error);
    return false;
  }
}

/**
 * Get all emails in the current hour batch
 */
export async function getCurrentHourBatch(): Promise<{
  [email: string]: any[];
} | null> {
  const currentHour = Math.floor(Date.now() / (1000 * 60 * 60));
  const key = `${EMAIL_BATCH_PREFIX}${currentHour}`;

  const redis = await getRedisConnection();
  if (!redis) {
    console.error("Redis connection not available");
    return null;
  }

  try {
    const batch = await redis.hgetall(key);
    const result: { [email: string]: any[] } = {};

    for (const [uniqueKey, messageDataStr] of Object.entries(batch)) {
      try {
        const parsed = JSON.parse(messageDataStr);
        // Extract replyFrom email from the unique key (format: "replyFrom->to")
        const replyFromEmail = uniqueKey.split("->")[0];

        // Group messages by replyFrom email
        if (!result[replyFromEmail]) {
          result[replyFromEmail] = [];
        }
        result[replyFromEmail].push(parsed);
      } catch (parseError) {
        console.error(
          "Error parsing message data for unique key:",
          uniqueKey,
          parseError
        );
        // Still try to extract replyFrom email for error logging
        const replyFromEmail = uniqueKey.split("->")[0];
        if (!result[replyFromEmail]) {
          result[replyFromEmail] = [];
        }
      }
    }

    return result;
  } catch (error) {
    console.error("Error getting current hour batch:", error);
    return null;
  }
}

/**
 * Remove processed emails from the current hour batch
 */
export async function removeEmailsFromBatch(
  replyFromEmails: string[]
): Promise<boolean> {
  const currentHour = Math.floor(Date.now() / (1000 * 60 * 60));
  const key = `${EMAIL_BATCH_PREFIX}${currentHour}`;

  const redis = await getRedisConnection();
  if (!redis) {
    console.error("Redis connection not available");
    return false;
  }

  try {
    if (replyFromEmails.length > 0) {
      // Get all keys in the batch
      const allKeys = await redis.hkeys(key);

      // Find keys that start with any of the replyFrom emails
      const keysToDelete = allKeys.filter((uniqueKey) => {
        const replyFromEmail = uniqueKey.split("->")[0];
        return replyFromEmails.includes(replyFromEmail);
      });

      if (keysToDelete.length > 0) {
        await redis.hdel(key, ...keysToDelete);
      }
    }
    return true;
  } catch (error) {
    console.error("Error removing emails from batch:", error);
    return false;
  }
}
