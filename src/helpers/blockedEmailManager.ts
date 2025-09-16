import {
  getAllBlockedEmails,
  getAuthFailureTimestamp,
  getTimeRemainingForBlockedEmail,
  removeAuthenticationFailure,
  markAuthenticationFailure,
  getAllCooldownEmails,
  getCooldownTimestamp,
  getTimeRemainingForCooldown,
  removeFromWarmupCooldownList,
  addToWarmupCooldownList,
} from "./redis";
import Logger from "../logger";

/**
 * Display all currently blocked emails with their details
 */
export async function displayBlockedEmails(): Promise<void> {
  try {
    const blockedEmails = await getAllBlockedEmails();
    const cooldownEmails = await getAllCooldownEmails();

    if (blockedEmails.length === 0 && cooldownEmails.length === 0) {
      console.log("✅ No emails are currently blocked or in cooldown");
      return;
    }

    // Display cooldown emails (2-day)
    if (cooldownEmails.length > 0) {
      console.log(
        `🔒 Found ${cooldownEmails.length} email(s) in COOLDOWN LIST (2-day):\n`
      );

      for (const email of cooldownEmails) {
        const timestamp = await getCooldownTimestamp(email);
        const timeRemaining = await getTimeRemainingForCooldown(email);

        const cooldownAt = timestamp
          ? new Date(timestamp).toISOString()
          : "Unknown";
        const remainingTime = timeRemaining
          ? `${Math.floor(timeRemaining / 86400)}d ${Math.floor(
              (timeRemaining % 86400) / 3600
            )}h ${Math.floor((timeRemaining % 3600) / 60)}m`
          : "Unknown";

        console.log(`📧 ${email}`);
        console.log(`   Added to cooldown: ${cooldownAt}`);
        console.log(`   Time remaining: ${remainingTime}`);
        console.log("");
      }
    }

    // Display blocked emails (8-hour)
    if (blockedEmails.length > 0) {
      console.log(
        `🚫 Found ${blockedEmails.length} email(s) BLOCKED (8-hour):\n`
      );

      for (const email of blockedEmails) {
        const timestamp = await getAuthFailureTimestamp(email);
        const timeRemaining = await getTimeRemainingForBlockedEmail(email);

        const blockedAt = timestamp
          ? new Date(timestamp).toISOString()
          : "Unknown";
        const remainingTime = timeRemaining
          ? `${Math.floor(timeRemaining / 3600)}h ${Math.floor(
              (timeRemaining % 3600) / 60
            )}m`
          : "Unknown";

        console.log(`📧 ${email}`);
        console.log(`   Blocked at: ${blockedAt}`);
        console.log(`   Time remaining: ${remainingTime}`);
        console.log("");
      }
    }
  } catch (error) {
    Logger.criticalError(
      "[BlockedEmailManager] Error displaying blocked emails:",
      {
        action: "Display Blocked Emails",
        error,
      },
      ["Error fetching blocked email information"]
    );
  }
}

/**
 * Manually unblock an email (emergency use)
 */
export async function unblockEmail(email: string): Promise<boolean> {
  try {
    const wasBlocked = await getAuthFailureTimestamp(email);
    if (!wasBlocked) {
      console.log(`ℹ️  Email ${email} is not currently blocked`);
      return false;
    }

    const success = await removeAuthenticationFailure(email);
    if (success) {
      console.log(`✅ Successfully unblocked email: ${email}`);
      Logger.info(`[BlockedEmailManager] Manually unblocked email: ${email}`);
      return true;
    } else {
      console.log(`❌ Failed to unblock email: ${email}`);
      return false;
    }
  } catch (error) {
    Logger.criticalError(
      "[BlockedEmailManager] Error unblocking email:",
      {
        action: "Unblock Email",
        email,
        error,
      },
      ["Error removing authentication failure status"]
    );
    return false;
  }
}

/**
 * Manually block an email (for testing or emergency use)
 */
export async function blockEmail(email: string): Promise<boolean> {
  try {
    const success = await markAuthenticationFailure(email);
    if (success) {
      console.log(`🚫 Successfully blocked email: ${email} for 8 hours`);
      Logger.info(`[BlockedEmailManager] Manually blocked email: ${email}`);
      return true;
    } else {
      console.log(`❌ Failed to block email: ${email}`);
      return false;
    }
  } catch (error) {
    Logger.criticalError(
      "[BlockedEmailManager] Error blocking email:",
      {
        action: "Block Email",
        email,
        error,
      },
      ["Error marking authentication failure"]
    );
    return false;
  }
}

/**
 * Manually remove email from cooldown list (emergency use)
 */
export async function removeCooldown(email: string): Promise<boolean> {
  try {
    const wasInCooldown = await getCooldownTimestamp(email);
    if (!wasInCooldown) {
      console.log(`ℹ️  Email ${email} is not currently in cooldown list`);
      return false;
    }

    const success = await removeFromWarmupCooldownList(email);
    if (success) {
      console.log(`✅ Successfully removed email from cooldown: ${email}`);
      Logger.info(
        `[BlockedEmailManager] Manually removed email from cooldown: ${email}`
      );
      return true;
    } else {
      console.log(`❌ Failed to remove email from cooldown: ${email}`);
      return false;
    }
  } catch (error) {
    Logger.criticalError(
      "[BlockedEmailManager] Error removing email from cooldown:",
      {
        action: "Remove Cooldown",
        email,
        error,
      },
      ["Error removing cooldown status"]
    );
    return false;
  }
}

/**
 * Manually add email to cooldown list (for testing or emergency use)
 */
export async function addCooldown(email: string): Promise<boolean> {
  try {
    const success = await addToWarmupCooldownList(email);
    if (success) {
      console.log(
        `🔒 Successfully added email to cooldown: ${email} for 2 days`
      );
      Logger.info(
        `[BlockedEmailManager] Manually added email to cooldown: ${email}`
      );
      return true;
    } else {
      console.log(`❌ Failed to add email to cooldown: ${email}`);
      return false;
    }
  } catch (error) {
    Logger.criticalError(
      "[BlockedEmailManager] Error adding email to cooldown:",
      {
        action: "Add Cooldown",
        email,
        error,
      },
      ["Error adding cooldown status"]
    );
    return false;
  }
}

/**
 * Check if a specific email is blocked/cooldown and show details
 */
export async function checkEmailStatus(email: string): Promise<void> {
  try {
    const cooldownTimestamp = await getCooldownTimestamp(email);
    const cooldownTimeRemaining = await getTimeRemainingForCooldown(email);

    const blockTimestamp = await getAuthFailureTimestamp(email);
    const blockTimeRemaining = await getTimeRemainingForBlockedEmail(email);

    let hasStatus = false;

    if (cooldownTimestamp) {
      const cooldownAt = new Date(cooldownTimestamp).toISOString();
      const remainingTime = cooldownTimeRemaining
        ? `${Math.floor(cooldownTimeRemaining / 86400)}d ${Math.floor(
            (cooldownTimeRemaining % 86400) / 3600
          )}h ${Math.floor((cooldownTimeRemaining % 3600) / 60)}m`
        : "Unknown";

      console.log(`🔒 Email ${email} is in COOLDOWN LIST (2-day)`);
      console.log(`   Added to cooldown: ${cooldownAt}`);
      console.log(`   Time remaining: ${remainingTime}`);
      hasStatus = true;
    }

    if (blockTimestamp) {
      const blockedAt = new Date(blockTimestamp).toISOString();
      const remainingTime = blockTimeRemaining
        ? `${Math.floor(blockTimeRemaining / 3600)}h ${Math.floor(
            (blockTimeRemaining % 3600) / 60
          )}m`
        : "Unknown";

      console.log(`🚫 Email ${email} is BLOCKED (8-hour)`);
      console.log(`   Blocked at: ${blockedAt}`);
      console.log(`   Time remaining: ${remainingTime}`);
      hasStatus = true;
    }

    if (!hasStatus) {
      console.log(`✅ Email ${email} is not blocked or in cooldown`);
    }
  } catch (error) {
    Logger.criticalError(
      "[BlockedEmailManager] Error checking email status:",
      {
        action: "Check Email Status",
        email,
        error,
      },
      ["Error fetching email status"]
    );
  }
}

// CLI interface for manual management
if (require.main === module) {
  const command = process.argv[2];
  const email = process.argv[3];

  switch (command) {
    case "list":
      displayBlockedEmails();
      break;
    case "unblock":
      if (!email) {
        console.log("Usage: ts-node blockedEmailManager.ts unblock <email>");
        process.exit(1);
      }
      unblockEmail(email);
      break;
    case "block":
      if (!email) {
        console.log("Usage: ts-node blockedEmailManager.ts block <email>");
        process.exit(1);
      }
      blockEmail(email);
      break;
    case "cooldown":
      if (!email) {
        console.log("Usage: ts-node blockedEmailManager.ts cooldown <email>");
        process.exit(1);
      }
      addCooldown(email);
      break;
    case "uncooldown":
      if (!email) {
        console.log("Usage: ts-node blockedEmailManager.ts uncooldown <email>");
        process.exit(1);
      }
      removeCooldown(email);
      break;
    case "check":
      if (!email) {
        console.log("Usage: ts-node blockedEmailManager.ts check <email>");
        process.exit(1);
      }
      checkEmailStatus(email);
      break;
    default:
      console.log("Usage:");
      console.log(
        "  ts-node blockedEmailManager.ts list                    - Show all blocked/cooldown emails"
      );
      console.log(
        "  ts-node blockedEmailManager.ts check <email>           - Check email status"
      );
      console.log(
        "  ts-node blockedEmailManager.ts unblock <email>         - Remove 8-hour block"
      );
      console.log(
        "  ts-node blockedEmailManager.ts block <email>           - Add 8-hour block"
      );
      console.log(
        "  ts-node blockedEmailManager.ts uncooldown <email>      - Remove from 2-day cooldown"
      );
      console.log(
        "  ts-node blockedEmailManager.ts cooldown <email>        - Add to 2-day cooldown"
      );
      process.exit(1);
  }
}
