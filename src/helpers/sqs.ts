import {
  DeleteMessageCommand,
  DeleteMessageCommandInput,
  ReceiveMessageCommand,
  ReceiveMessageCommandInput,
  SendMessageCommand,
  SendMessageCommandInput,
  ChangeMessageVisibilityCommand,
  SQS,
} from "@aws-sdk/client-sqs";
import { sqs, QUEUE_URL } from "./aws";
import {
  MAX_NUMBER_OF_MESSAGES_TO_PROCESS,
  VISIBILITY_TIMEOUT,
  WAIT_TIME_SECONDS,
} from "../data/config";
import { parse } from "dotenv";
import Logger from "../logger";

// Type for SQS message
export interface SQSMessage {
  Body: string;
  ReceiptHandle: string;
  Attributes?: {
    ApproximateReceiveCount?: string;
  };
}

// Function to receive messages from SQS
export async function receiveMessageFromQueue(): Promise<SQSMessage[] | null> {
  const params: ReceiveMessageCommandInput = {
    QueueUrl: QUEUE_URL,
    MaxNumberOfMessages: MAX_NUMBER_OF_MESSAGES_TO_PROCESS,
    VisibilityTimeout: VISIBILITY_TIMEOUT,
    WaitTimeSeconds: WAIT_TIME_SECONDS,
    AttributeNames: ["ApproximateReceiveCount" as any],
  };

  return new Promise(async (resolve, reject) => {
    const res = await sqs.send(new ReceiveMessageCommand(params));
    if (res.Messages) {
      resolve(res.Messages as SQSMessage[]);
    } else {
      resolve(null);
    }
  });
}

// Function to delete a message from SQS
export async function deleteMessageFromQueue(
  receiptHandle: string
): Promise<void> {
  const deleteParams: DeleteMessageCommandInput = {
    QueueUrl: QUEUE_URL,
    ReceiptHandle: receiptHandle,
  };

  const res = await sqs.send(new DeleteMessageCommand(deleteParams));
  if (res.$metadata.httpStatusCode === 200) {
    console.log("Message deleted from queue");
  } else {
    Logger.error("[DeleteMessageFromQueue] Error deleting message", {
      receiptHandle,
    });
    throw new Error("Error deleting message");
  }
}

// Function to delay a message by sending it back to SQS with delay
export async function delayMessageInQueue(
  messageBody: string,
  delaySeconds: number
): Promise<boolean> {
  // SQS maximum delay is 900 seconds (15 minutes), so we need to handle longer delays differently
  const maxSqsDelay = 900;
  const actualDelay = Math.min(delaySeconds, maxSqsDelay);

  const sendParams: SendMessageCommandInput = {
    QueueUrl: QUEUE_URL,
    MessageBody: messageBody,
    DelaySeconds: actualDelay,
  };

  try {
    const res = await sqs.send(new SendMessageCommand(sendParams));
    if (res.$metadata.httpStatusCode === 200) {
      Logger.info("[DelayMessageInQueue] Message delayed successfully", {
        delaySeconds: actualDelay,
        messageId: res.MessageId,
      });
      return true;
    } else {
      Logger.error("[DelayMessageInQueue] Failed to delay message", {
        httpStatusCode: res.$metadata.httpStatusCode,
      });
      return false;
    }
  } catch (error) {
    Logger.error("[DelayMessageInQueue] Error delaying message", { error });
    return false;
  }
}

// Function to schedule a message for future processing (for delays > 15 minutes)
// This puts a marker in the batch system that will be processed later
export async function scheduleMessageForFuture(
  messageBody: string,
  scheduleForTimestamp: number
): Promise<boolean> {
  try {
    // For now, we'll use a simple approach: add a scheduled timestamp to the message
    const messageData = JSON.parse(messageBody);
    messageData.scheduledFor = scheduleForTimestamp;

    // Send it back with maximum SQS delay (15 minutes)
    // The processing logic will check if the scheduled time has passed
    return await delayMessageInQueue(JSON.stringify(messageData), 900);
  } catch (error) {
    Logger.error("[ScheduleMessageForFuture] Error scheduling message", {
      error,
    });
    return false;
  }
}

// Helper function to get the receive count of a message
export function getMessageReceiveCount(message: SQSMessage): number {
  return parseInt(message.Attributes?.ApproximateReceiveCount || "0");
}

// Function to hide a message for 12 hours using visibility timeout
export async function hideMessageFor12Hours(
  receiptHandle: string
): Promise<boolean> {
  const twelveHoursInSeconds = 12 * 60 * 60; // 12 hours = 43,200 seconds (max SQS visibility timeout)

  const params = {
    QueueUrl: QUEUE_URL,
    ReceiptHandle: receiptHandle,
    VisibilityTimeout: twelveHoursInSeconds,
  };

  try {
    const res = await sqs.send(new ChangeMessageVisibilityCommand(params));
    if (res.$metadata.httpStatusCode === 200) {
      Logger.info(
        "[HideMessageFor12Hours] Message hidden for 12 hours successfully",
        {
          receiptHandle: receiptHandle.substring(0, 50) + "...", // Log partial receipt handle for debugging
          visibilityTimeout: twelveHoursInSeconds,
        }
      );
      return true;
    } else {
      Logger.error("[HideMessageFor12Hours] Failed to hide message", {
        httpStatusCode: res.$metadata.httpStatusCode,
        receiptHandle: receiptHandle.substring(0, 50) + "...",
      });
      return false;
    }
  } catch (error) {
    Logger.error("[HideMessageFor12Hours] Error hiding message", {
      error,
      receiptHandle: receiptHandle.substring(0, 50) + "...",
    });
    return false;
  }
}
