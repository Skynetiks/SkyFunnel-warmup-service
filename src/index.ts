import { z } from "zod";
import { logEmailResponse } from "./helpers/database";
import { sendEmail } from "./helpers/nodemailer";
import {
  receiveMessageFromQueue,
  deleteMessageFromQueue,
  SQSMessage,
} from "./helpers/sqs";
import {
  CheckAndUpdateSpamInDb,
  checkEmailInSpam,
} from "./helpers/spamChecker";
import { REFRESH_TIME_IM_MILLISECONDS } from "./data/config";

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
  console.error(err);
  console.log("Node NOT Exiting...");
});

async function processMessage(message: SQSMessage): Promise<void> {
  let email = "";
  const memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024; // Convert to MB


  try {
    email = JSON.parse(message.Body);
  } catch (jsonError) {
    console.error(
      `JSON Parsing Error for message with Receipt Handle: ${message.ReceiptHandle}. Error: ${jsonError}`
    );
    // Skip processing this message but don't crash the entire app
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

    console.log("Processing Message With email: ", to);

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
        console.error("Failed to send email");
        return;
      }

      console.log(`Replied to ${to}`);
      await logEmailResponse(warmupId, to, "REPLIED");
    }

    // Will only be triggered if every thing is ok
    await deleteMessageFromQueue(message.ReceiptHandle);
  } catch (error) {
    // Got an unexpected error, log it and continue Most probably a parse error for the body or error while sending email
    console.error("Error processing message:", error);
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
      // TODO: Error must be logged to Sentry or equivalent other logging service
      console.error(
        `Error Processing a Message with a Receipt Handle: ${message.ReceiptHandle} Error: ${error}`
      );
    }
  }

  await Promise.all(promiseArray);
}


async function processMessagesAndScheduleNext(): Promise<void> {
  await handleMessages();

  setTimeout(processMessagesAndScheduleNext, REFRESH_TIME_IM_MILLISECONDS);
}

console.log("💻 Warmup Server Started");
// Start the recursive message handling process
processMessagesAndScheduleNext();
