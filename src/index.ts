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
import { CONFIGURATIONS } from "./data/mail-configuration";
import { REFRESH_TIME_IM_MILLISECONDS } from "./data/config";

const EmailSchema = z.object({
  to: z.string(),
  originalSubject: z.string(),
  body: z.string(),
  keyword: z.string(),
  warmupId: z.string(),
  referenceId: z.string().optional(),
  inReplyTo: z.string().optional(),
  replyFrom: z.string().optional(),
  customMailId: z.string(),
  shouldReply: z.boolean().default(true),
});

async function processMessage(message: SQSMessage): Promise<void> {
  const startTime = performance.now();
  const email = JSON.parse(message.Body);

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
      await sendEmail(
        to,
        originalSubject,
        body,
        keyword,
        inReplyTo || "",
        referenceId || "",
        replyFrom || CONFIGURATIONS[0].user
      );

      console.log(`Replied to ${to}`);
      // await logEmailResponse(warmupId, to, "REPLIED");
    }

    const endTime = performance.now();
    console.log(
      "Time taken to process message: ",
      (endTime - startTime) / 1000
    );

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
console.log(
  "Will check for new messages every",
  REFRESH_TIME_IM_MILLISECONDS / 1000,
  "seconds"
);

// Start the recursive message handling process
processMessagesAndScheduleNext();

