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

// Authentication failure tracking functions
const AUTH_FAILURE_PREFIX = "auth_fail:";
const BLOCKED_EMAIL_PREFIX = "blocked_email:";
const EMAIL_BATCH_PREFIX = "email_batch:";
const COOLDOWN_LIST_PREFIX = "warmup_cooldown:";
const EIGHT_HOURS_IN_SECONDS = 8 * 60 * 60; // 8 hours
const ONE_HOUR_IN_SECONDS = 60 * 60; // 1 hour (fixed from 10 minutes)
const TWO_DAYS_IN_SECONDS = 2 * 24 * 60 * 60; // 2 days

/**
 * Mark an email as having authentication failure with 8-hour expiry
 */
export async function markAuthenticationFailure(
  email: string
): Promise<boolean> {
  const key = `${AUTH_FAILURE_PREFIX}${email}`;
  const timestamp = Date.now().toString();
  return await setRedisKeyValue(key, timestamp, EIGHT_HOURS_IN_SECONDS);
}

/**
 * Check if an email has authentication failure (is blocked)
 */
export async function isEmailBlocked(email: string): Promise<boolean> {
  const key = `${AUTH_FAILURE_PREFIX}${email}`;
  const value = await getRedisKeyValue(key);
  return value !== null;
}

/**
 * Remove authentication failure status for an email
 */
export async function removeAuthenticationFailure(
  email: string
): Promise<boolean> {
  const key = `${AUTH_FAILURE_PREFIX}${email}`;
  return await deleteRedisKey(key);
}

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

/**
 * Get all currently blocked emails for monitoring/debugging
 */
export async function getAllBlockedEmails(): Promise<string[]> {
  const redis = await getRedisConnection();
  if (!redis) {
    console.error("Redis connection not available");
    return [];
  }

  try {
    const keys = await redis.keys(`${AUTH_FAILURE_PREFIX}*`);
    return keys.map((key) => key.replace(AUTH_FAILURE_PREFIX, ""));
  } catch (error) {
    console.error("Error getting blocked emails:", error);
    return [];
  }
}

/**
 * Get the timestamp when an email was blocked
 */
export async function getAuthFailureTimestamp(
  email: string
): Promise<number | null> {
  const key = `${AUTH_FAILURE_PREFIX}${email}`;
  const value = await getRedisKeyValue(key);
  if (value) {
    try {
      return parseInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Check how much time is left on a blocked email (in seconds)
 */
export async function getTimeRemainingForBlockedEmail(
  email: string
): Promise<number | null> {
  const redis = await getRedisConnection();
  if (!redis) {
    console.error("Redis connection not available");
    return null;
  }

  try {
    const key = `${AUTH_FAILURE_PREFIX}${email}`;
    const ttl = await redis.ttl(key);
    return ttl > 0 ? ttl : null;
  } catch (error) {
    console.error("Error getting TTL for blocked email:", error);
    return null;
  }
}

// ===============================================================================================
// MARK: ========================== Warmup Service Cooldown List ===============================
// ===============================================================================================

/**
 * Add email to warmup service cooldown list with 2-day expiry
 * This is for severe authentication failures that require longer cooldown
 */
export async function addToWarmupCooldownList(email: string): Promise<boolean> {
  const key = `${COOLDOWN_LIST_PREFIX}${email}`;
  const timestamp = Date.now().toString();
  return await setRedisKeyValue(key, timestamp, TWO_DAYS_IN_SECONDS);
}

/**
 * Check if an email is in the warmup service cooldown list
 */
export async function isEmailInCooldownList(email: string): Promise<boolean> {
  const key = `${COOLDOWN_LIST_PREFIX}${email}`;
  const value = await getRedisKeyValue(key);
  return value !== null;
}

/**
 * Remove email from warmup service cooldown list
 */
export async function removeFromWarmupCooldownList(
  email: string
): Promise<boolean> {
  const key = `${COOLDOWN_LIST_PREFIX}${email}`;
  return await deleteRedisKey(key);
}

/**
 * Get the timestamp when an email was added to cooldown list
 */
export async function getCooldownTimestamp(
  email: string
): Promise<number | null> {
  const key = `${COOLDOWN_LIST_PREFIX}${email}`;
  const value = await getRedisKeyValue(key);
  if (value) {
    try {
      return parseInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Check how much time is left on cooldown (in seconds)
 */
export async function getTimeRemainingForCooldown(
  email: string
): Promise<number | null> {
  const redis = await getRedisConnection();
  if (!redis) {
    console.error("Redis connection not available");
    return null;
  }

  try {
    const key = `${COOLDOWN_LIST_PREFIX}${email}`;
    const ttl = await redis.ttl(key);
    return ttl > 0 ? ttl : null;
  } catch (error) {
    console.error("Error getting TTL for cooldown email:", error);
    return null;
  }
}

/**
 * Get all emails currently in cooldown list
 */
export async function getAllCooldownEmails(): Promise<string[]> {
  const redis = await getRedisConnection();
  if (!redis) {
    console.error("Redis connection not available");
    return [];
  }

  try {
    const keys = await redis.keys(`${COOLDOWN_LIST_PREFIX}*`);
    return keys.map((key) => key.replace(COOLDOWN_LIST_PREFIX, ""));
  } catch (error) {
    console.error("Error getting cooldown emails:", error);
    return [];
  }
}
