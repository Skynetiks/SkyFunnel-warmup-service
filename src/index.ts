import { z } from "zod";
import { logEmailResponse } from "./helpers/database";
import { sendEmail } from "./helpers/nodemailer";
import {
  receiveMessageFromQueue,
  deleteMessageFromQueue,
  SQSMessage,
} from "./helpers/sqs";
import { CheckAndUpdateSpamInDb } from "./helpers/spamChecker";
// import { REFRESH_TIME_IN_MILLISECONDS } from "./data/config";
import Logger from "./logger";

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

async function processMessage(message: SQSMessage): Promise<void> {
  let email = "";

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
      },
      [
        "Something Went Wrong While Parsing Message",
        "Make sure message is correct",
      ]
    );
    return; // Don't delete message on parsing error
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

    console.log("Processing Message With email: ", to);
    Logger.info("[ProcessMessage] Processing Message With email: ", { to });

    // Ignore the situation of error and continues
    await CheckAndUpdateSpamInDb(customMailId, replyFrom, warmupId, to);

    if (shouldReply) {
      const success = await sendEmail(
        to,
        originalSubject,
        body,
        keyword,
        inReplyTo || "",
        referenceId || "",
        replyFrom
      );

      if (!success) {
        Logger.error("[ProcessMessage] Failed to send email", { to });
        return; // Don't delete message on email send failure
      }

      Logger.info("[ProcessMessage] Replied to", { to });
      await logEmailResponse(warmupId, to, "REPLIED");
    }

    // Will only be triggered if every thing is ok
    await deleteMessageFromQueue(message.ReceiptHandle);
    Logger.info("[ProcessMessage] Message deleted from queue", {
      receiptHandle: message.ReceiptHandle,
    });
  } catch (error) {
    // Got an unexpected error, log it and continue Most probably a parse error for the body or error while sending email
    Logger.criticalError(
      "[ProcessMessage] Error processing message:",
      {
        action: "Processing Message",
        error,
        receiptHandle: message.ReceiptHandle,
      },
      [
        "Something Went Wrong While Processing Message",
        "Make sure message is correct",
      ]
    );
    // Don't delete message on error - let it retry
  }
}

async function handleMessages(): Promise<void> {
  console.log("Handling New Batch of Messages");
  const messages: SQSMessage[] | null = await receiveMessageFromQueue();

  let promiseArray: Promise<any>[] = [];

  if (!messages) return;
  for (const message of messages) {
    try {
      const promise = processMessage(message);

      promiseArray.push(promise);
    } catch (error) {
      // Got an unexpected error, log it and continue

      Logger.criticalError(
        "[HandleMessages] Error Processing a Message with a Receipt Handle:",
        {
          action: "Processing Message",
          error,
          receiptHandle: message.ReceiptHandle,
        },
        ["Something Went Wrong While Processing Message", "Unhandled Error"]
      );
    }
  }

  await Promise.allSettled(promiseArray);
}

async function processMessagesAndScheduleNext(): Promise<void> {
  await handleMessages();

  setImmediate(processMessagesAndScheduleNext);
}

console.log("💻 Warmup Server Started");
// Start the recursive message handling process
processMessagesAndScheduleNext();
