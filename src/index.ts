import { z } from "zod";
import { logEmailResponse } from "./helpers/database";
import { sendEmail } from "./helpers/nodemailer";
import {
  receiveMessageFromQueue,
  deleteMessageFromQueue,
  delayMessageInQueue,
  scheduleMessageForFuture,
  hideMessageFor12Hours,
  getMessageReceiveCount,
  SQSMessage,
} from "./helpers/sqs";
import { CheckAndUpdateSpamInDb } from "./helpers/spamChecker";
// import { REFRESH_TIME_IN_MILLISECONDS } from "./data/config";
import Logger from "./logger";
import {
  addEmailToBatch,
  getCurrentHourBatch,
  removeEmailsFromBatch,
} from "./helpers/redis";

const EmailSchema = z.object({
  to: z.string(),
  originalSubject: z.string(),
  body: z.string(),
  keyword: z.string(),
  warmupId: z.string(),
  referenceId: z.string().optional(),
  inReplyTo: z.string().optional(),
  replyFrom: z.string(),
  customMailId: z.string(),
  shouldReply: z.boolean().default(true),
  scheduledFor: z.number().optional(), // Timestamp for delayed processing
});

process.on("uncaughtException", function (err) {
  Logger.criticalError(
    "[Main] Uncaught Exception",
    {
      action: "Uncaught Exception",
      error: err,
    },
    ["Something Uncaught Error Happened"]
  );
});

async function addMessageToBatch(message: SQSMessage): Promise<void> {
  let email = "";

  const receiveCount = getMessageReceiveCount(message);
  try {
    email = JSON.parse(message.Body);
  } catch (jsonError) {
    Logger.error(
      "[ParsingMessage] JSON Parsing Error",
      {
        action: "JSON Parsing Error",
        error: jsonError,
        receiptHandle: message.ReceiptHandle,
        message: message.Body,
        receiveCount,
      },
      [
        "Something Went Wrong While Parsing Message",
        "Make sure message is correct",
      ]
    );
    // Delete malformed messages to prevent infinite loops
    await deleteMessageFromQueue(message.ReceiptHandle);
    return;
  }

  try {
    const {
      to,
      originalSubject,
      body,
      keyword,
      warmupId,
      referenceId,
      inReplyTo,
      replyFrom,
      customMailId,
      shouldReply,
    } = EmailSchema.parse(email);

    Logger.info(`[AddMessageToBatch] Adding message to batch for email: ${to} to be replied by ${replyFrom}`, );

    // Add message to the current hour batch
    const messageData = {
      to,
      originalSubject,
      body,
      keyword,
      warmupId,
      referenceId,
      inReplyTo,
      replyFrom,
      customMailId,
      shouldReply,
      receiptHandle: message.ReceiptHandle,
      addedAt: Date.now(),
      receiveCount: receiveCount,
    };

    const batchAdded = await addEmailToBatch(replyFrom, messageData);
    if (batchAdded) {
      Logger.info("[AddMessageToBatch] Message added to batch successfully");
      // Delete message from SQS immediately after successful batch addition
      await deleteMessageFromQueue(message.ReceiptHandle);
    } else {
      Logger.error("[AddMessageToBatch] Failed to add message to batch");
    }
  } catch (error) {
    Logger.criticalError(
      "[AddMessageToBatch] Error processing message:",
      {
        action: "Adding Message to Batch",
        error,
        receiptHandle: message.ReceiptHandle,
      },
      [
        "Something Went Wrong While Adding Message to Batch",
        "Make sure message is correct",
      ]
    );
    // Don't delete message on error - let it retry
  }
}

async function processBatchedEmails(): Promise<void> {
  Logger.info(
    "[ProcessBatchedEmails] Starting to process batched emails for current hour"
  );

  try {
    const batch = await getCurrentHourBatch();
    if (!batch || Object.keys(batch).length === 0) {
      Logger.info("[ProcessBatchedEmails] No emails in current hour batch");
      return;
    }

    const processedEmails: string[] = [];
    const successfullyProcessedMessages: string[] = [];

    // Process each unique email in the batch
    for (const [replyFromEmail, messagesArray] of Object.entries(batch)) {
      try {
        Logger.info(
          `[ProcessBatchedEmails] Processing batched email: ${replyFromEmail} with 1 message (deduplication ensures only one message per email per hour)`
        );

        // Process spam check for this email (only once per hour per email)
        // Use the first message for spam check (since we only need to check once per email per hour)
        const firstMessage = messagesArray[0];
        const spamCheckResult = await CheckAndUpdateSpamInDb(
          firstMessage.customMailId,
          replyFromEmail,
          firstMessage.warmupId,
          firstMessage.to
        );

        if (!spamCheckResult.shouldContinue) {
          Logger.info(
            `[ProcessBatchedEmails] Spam check failed for ${replyFromEmail}: ${spamCheckResult.reason}`
          );

          // If it's an auth failure, skip processing
          if (spamCheckResult.reason?.includes("authentication failure")) {
            Logger.info(
              `[ProcessBatchedEmails] Authentication failure detected for ${replyFromEmail}. Processing 1 message.`
            );

            const messageData = messagesArray[0];
            const receiveCount = messageData.receiveCount || 1;

            // Message already deleted from SQS when added to batch
            Logger.info(
              `[ProcessBatchedEmails] Message for ${replyFromEmail} processed ${receiveCount} times and still failing. Already deleted from SQS.`
            );
            processedEmails.push(replyFromEmail);
          }
          continue;
        }

        // Process all messages for this email account
        let successfulMessages = 0;
        for (const messageData of messagesArray) {
          try {
            // Send email if shouldReply is true
            if (messageData.shouldReply) {
              const success = await sendEmail(
                messageData.to,
                messageData.originalSubject,
                messageData.body,
                messageData.keyword,
                messageData.inReplyTo || "",
                messageData.referenceId || "",
                replyFromEmail
              );

              if (success) {
                Logger.info(
                  `[ProcessBatchedEmails] Successfully sent email to ${messageData.to} from ${replyFromEmail}`
                );
                await logEmailResponse(
                  messageData.warmupId,
                  messageData.to,
                  "REPLIED"
                );
                // Message already deleted from SQS when added to batch
                successfullyProcessedMessages.push(messageData.receiptHandle);
                successfulMessages++;
              } else {
                Logger.error(
                  `[ProcessBatchedEmails] Failed to send email to ${messageData.to} from ${replyFromEmail}`
                );
                // If this fails due to auth error, future messages will be skipped
                // Message will be retried in next cycle if not an auth error
              }
            } else {
              // Message already deleted from SQS when added to batch
              successfullyProcessedMessages.push(messageData.receiptHandle);
              successfulMessages++;
            }
          } catch (messageError) {
            Logger.error(
              `[ProcessBatchedEmails] Error processing individual message for ${replyFromEmail}:`,
              { error: messageError, replyFromEmail }
            );
          }
        }

        Logger.info(
          `[ProcessBatchedEmails] Completed processing ${replyFromEmail}: ${successfulMessages}/${messagesArray.length} messages successful`
        );
        processedEmails.push(replyFromEmail);
      } catch (error) {
        Logger.criticalError(
          "[ProcessBatchedEmails] Error processing batched email:",
          {
            action: "Processing Batched Email",
            error,
            replyFromEmail,
            messageCount: messagesArray?.length || 0,
          },
          ["Error processing individual batched email"]
        );
      }
    }

    // Remove processed emails from the batch
    if (processedEmails.length > 0) {
      await removeEmailsFromBatch(processedEmails);
      Logger.info(
        `[ProcessBatchedEmails] Removed ${processedEmails.length} processed emails from batch`
      );
    }

    Logger.info(
      `[ProcessBatchedEmails] Completed processing batch. Processed: ${processedEmails.length}, Successful messages: ${successfullyProcessedMessages.length}`
    );
  } catch (error) {
    Logger.criticalError(
      "[ProcessBatchedEmails] Error processing batched emails:",
      {
        action: "Processing Batched Emails",
        error,
      },
      ["Error in main batch processing logic"]
    );
  }
}

async function handleMessages(): Promise<void> {
  console.log("Handling New Batch of Messages - Adding to batch system");
  const messages: SQSMessage[] | null = await receiveMessageFromQueue();

  let promiseArray: Promise<any>[] = [];

  if (!messages) return;
  for (const message of messages) {
    try {
      const promise = addMessageToBatch(message);
      promiseArray.push(promise);
    } catch (error) {
      // Got an unexpected error, log it and continue
      Logger.criticalError(
        "[HandleMessages] Error Processing a Message with a Receipt Handle:",
        {
          action: "Adding Message to Batch",
          error,
          receiptHandle: message.ReceiptHandle,
        },
        [
          "Something Went Wrong While Adding Message to Batch",
          "Unhandled Error",
        ]
      );
    }
  }

  await Promise.allSettled(promiseArray);
}

async function collectMessagesAndScheduleNext(): Promise<void> {
  await handleMessages();
  setTimeout(collectMessagesAndScheduleNext, 2 * 60 * 1000); // Check for new messages every 2 minutes
}

async function processBatchAndScheduleNext(): Promise<void> {
  await processBatchedEmails();
  setTimeout(processBatchAndScheduleNext, 60 * 60 * 1000); // Process batched emails every hour
}

console.log("💻 Warmup Server Started");
console.log("📧 Message Collection: Every 2 minutes");
console.log("🔄 Batch Processing: Every hour");
console.log("🛡️  Authentication failure protection: 2 Days");

// Start both processes
collectMessagesAndScheduleNext(); // Collect messages frequently
processBatchAndScheduleNext(); // Process batches hourly
