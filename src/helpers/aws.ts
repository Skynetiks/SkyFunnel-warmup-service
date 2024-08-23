import { SQSClient } from "@aws-sdk/client-sqs";
import dotenv from "dotenv";
dotenv.config();

if (!process.env.S3_REGION) {
  throw new Error("S3_REGION is required");
}

if (!process.env.S3_ACCESS_KEY_ID) {
  throw new Error("S3_ACCESS_KEY_ID is required");
}

if (!process.env.S3_SECRET_ACCESS_KEY) {
  throw new Error("S3_SECRET_ACCESS_KEY is required");
}

if(!process.env.QUEUE_URL){
  throw new Error("QUEUE_URL is required");
}

export const sqs = new SQSClient({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});


export const QUEUE_URL=process.env.QUEUE_URL;
