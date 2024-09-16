import { DeleteMessageCommand, DeleteMessageCommandInput, ReceiveMessageCommand, ReceiveMessageCommandInput, SQS } from '@aws-sdk/client-sqs';
import { sqs, QUEUE_URL } from './aws';
import { MAX_NUMBER_OF_MESSAGES_TO_PROCESS, VISIBILITY_TIMEOUT, WAIT_TIME_SECONDS } from '../data/config';
import { parse } from 'dotenv';

// Type for SQS message
export interface SQSMessage {
  Body: string;
  ReceiptHandle: string;
}

// Function to receive messages from SQS
export async function receiveMessageFromQueue(): Promise<SQSMessage[] | null> {
    const params: ReceiveMessageCommandInput = {
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: MAX_NUMBER_OF_MESSAGES_TO_PROCESS,
        VisibilityTimeout: VISIBILITY_TIMEOUT,
        WaitTimeSeconds: WAIT_TIME_SECONDS,
      };

  return new Promise(async(resolve, reject) => {
    const res = await sqs.send(new ReceiveMessageCommand(params))
    if(res.Messages){
      const filtered = res.Messages.filter((message) => parseInt(message.Attributes?.ApproximateReceiveCount || "0") < 2);
    
      resolve(filtered as SQSMessage[]);
    } 
    else{
      resolve(null);
    }
  });
}

// Function to delete a message from SQS
export async function deleteMessageFromQueue(receiptHandle: string): Promise<void> {
  const deleteParams: DeleteMessageCommandInput = {
    QueueUrl: QUEUE_URL,
    ReceiptHandle: receiptHandle,
  };

  const res = await sqs.send(new DeleteMessageCommand(deleteParams));
  if(res.$metadata.httpStatusCode === 200){
    console.log('Message deleted from queue');
  }
  else {
    console.error('Error deleting message:', res);
    throw new Error('Error deleting message');
  }
}
