/**
 * OrderProcessor Lambda
 *
 * SQS-triggered. Consumes OrderCreated events from OrderProcessorQueue,
 * updates DynamoDB row to status='COMPLETED', writes a receipt JSON to
 * S3 at a deterministic key (receipts/${orderId}.json - idempotent for
 * EventBridge archive replay), and logs a presigned GET URL for the
 * receipt (Module 5 talking point).
 *
 * Chaos:
 *   - coffeeType === 'POISON_PILL': throw. SQS retries 3x via visibility
 *     timeout, then DLQ. DLQ depth alarm fires. Organic demo of the full
 *     SQS failure path.
 *
 * Returns partial batch failures per SQS reportBatchItemFailures contract
 * so a single poison pill does not retry the whole batch.
 */

// NOTE (scaffold): @aws-sdk/s3-request-presigner is NOT in the Lambda Node 20
// managed runtime. When we switch this Lambda to NodejsFunction (esbuild
// bundling) we can re-enable the import below. For scaffold correctness we
// log the S3 object ARN instead; attendees generate the presigned URL on
// demand via `aws s3 presign s3://<bucket>/<key>`.

import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
// import { getSignedUrl } from '@aws-sdk/s3-request-presigner'; // TODO: bundle via NodejsFunction
// import { GetObjectCommand } from '@aws-sdk/client-s3';
import { formatTimestamp } from '/opt/nodejs/node_modules/shared-utils/utils.mjs';

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});

const ORDERS_TABLE = process.env.ORDERS_TABLE;
const RECEIPTS_BUCKET = process.env.RECEIPTS_BUCKET;

export const handler = async (event) => {
  const batchItemFailures = [];

  for (const record of event.Records) {
    try {
      const msg = JSON.parse(record.body);
      const detail = msg.detail;
      const { orderId, coffeeType, size } = detail;

      // --- Chaos: POISON_PILL causes processor to throw ---
      if (coffeeType === 'POISON_PILL') {
        throw new Error(`POISON_PILL for orderId=${orderId}`);
      }

      // --- Update DDB status -> COMPLETED ---
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

      // --- Put receipt to S3 (deterministic key - idempotent on replay) ---
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

      // --- Log S3 location (Module 5 demo) ---
      // TODO: once Lambda is switched to NodejsFunction for esbuild bundling,
      // re-enable @aws-sdk/s3-request-presigner and log a ready-to-click URL.
      console.log(
        JSON.stringify({
          message: 'Order processed',
          orderId,
          receiptKey,
          s3Uri: `s3://${RECEIPTS_BUCKET}/${receiptKey}`,
          presignHint: `aws s3 presign s3://${RECEIPTS_BUCKET}/${receiptKey} --expires-in 3600`,
        }),
      );
    } catch (err) {
      console.error('Processing failed', {
        messageId: record.messageId,
        error: err.message,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
