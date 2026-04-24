/**
 * OrderProcessor Lambda (TypeScript, bundled by NodejsFunction/esbuild).
 *
 * SQS-triggered. POISON_PILL chaos -> throws -> DLQ after 3 SQS retries.
 * Uses SQS partial batch response so one poison pill doesn't retry the batch.
 *
 * Receipt key is deterministic (receipts/${orderId}.json) so EventBridge
 * archive replay is idempotent - replay overwrites in place, no dupes.
 *
 * Presigned GET URL via @aws-sdk/s3-request-presigner (bundled by esbuild,
 * not in Lambda managed runtime).
 */

import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { formatTimestamp } from 'shared-utils';

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});

const ORDERS_TABLE = process.env.ORDERS_TABLE!;
const RECEIPTS_BUCKET = process.env.RECEIPTS_BUCKET!;

interface OrderDetail {
  orderId: string;
  coffeeType: string;
  size: string;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const msg = JSON.parse(record.body) as { detail: OrderDetail };
      const { orderId, coffeeType, size } = msg.detail;

      // Chaos: POISON_PILL -> throw -> SQS retry 3x -> DLQ
      if (coffeeType === 'POISON_PILL') {
        throw new Error(`POISON_PILL for orderId=${orderId}`);
      }

      await ddb.send(
        new UpdateItemCommand({
          TableName: ORDERS_TABLE,
          Key: { orderId: { S: orderId } },
          UpdateExpression: 'SET #s = :s, completedAt = :t',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':s': { S: 'COMPLETED' },
            ':t': { S: formatTimestamp() },
          },
        }),
      );

      const receiptKey = `receipts/${orderId}.json`;
      const receipt = {
        orderId,
        coffeeType,
        size,
        status: 'COMPLETED',
        completedAt: formatTimestamp(),
      };
      await s3.send(
        new PutObjectCommand({
          Bucket: RECEIPTS_BUCKET,
          Key: receiptKey,
          Body: JSON.stringify(receipt, null, 2),
          ContentType: 'application/json',
        }),
      );

      // Presigned GET URL for Module 5 demo
      const presignedUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: RECEIPTS_BUCKET, Key: receiptKey }),
        { expiresIn: 3600 },
      );

      console.log(
        JSON.stringify({
          message: 'Order processed',
          orderId,
          receiptKey,
          presignedUrl,
        }),
      );
    } catch (err) {
      const error = err as Error;
      console.error(
        JSON.stringify({
          message: 'Processing failed',
          messageId: record.messageId,
          error: error.message,
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
