/**
 * OrderReceiver Lambda
 *
 * Receives POST /orders requests from API Gateway. Validates the body (API
 * Gateway model validator already did this), injects chaos based on
 * coffeeType, writes to DynamoDB, publishes OrderCreated to EventBridge.
 *
 * Chaos branches:
 *   - coffeeType === 'FATAL_ERROR': throws (surfaces as API GW 500)
 *   - coffeeType === 'SLOW_BREW':   4s delay before success
 *   - coffeeType === 'POISON_PILL': 200 OK but event payload marks the
 *                                   downstream processor to fail (handled
 *                                   in order-processor).
 *
 * EMF metric emit: CloudWatch Embedded Metric Format via stdout.
 *   Namespace: CloudKaffe
 *   Dimensions: CoffeeType
 *   Metric: CoffeeSold (Count)
 *
 * TODO(impl): write full body per design doc \u00a76. Currently a stub returning 200.
 */

import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import {
  formatTimestamp,
  generateOrderId,
} from '/opt/nodejs/node_modules/shared-utils/utils.mjs';

const ddb = new DynamoDBClient({});
const eb = new EventBridgeClient({});

const ORDERS_TABLE = process.env.ORDERS_TABLE;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME;

export const handler = async (event) => {
  const body = JSON.parse(event.body ?? '{}');
  const { coffeeType, size } = body;

  // --- Chaos branches ---
  if (coffeeType === 'FATAL_ERROR') {
    throw new Error('Simulated Database Crash');
  }
  if (coffeeType === 'SLOW_BREW') {
    await new Promise((r) => setTimeout(r, 4000));
  }

  const orderId = generateOrderId();
  const now = formatTimestamp();
  const ttl = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24h TTL

  // --- Write to DDB ---
  await ddb.send(
    new PutItemCommand({
      TableName: ORDERS_TABLE,
      Item: {
        orderId: { S: orderId },
        coffeeType: { S: coffeeType },
        size: { S: size },
        status: { S: 'PENDING' },
        createdAt: { S: now },
        expiresAt: { N: String(ttl) },
      },
    }),
  );

  // --- Publish OrderCreated ---
  await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: EVENT_BUS_NAME,
          Source: 'cloud-kaffe.receiver',
          DetailType: 'OrderCreated',
          Detail: JSON.stringify({ orderId, coffeeType, size, createdAt: now }),
        },
      ],
    }),
  );

  // --- EMF metric emit ---
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'CloudKaffe',
          Dimensions: [['CoffeeType']],
          Metrics: [{ Name: 'CoffeeSold', Unit: 'Count' }],
        },
      ],
    },
    CoffeeType: coffeeType,
    CoffeeSold: 1,
  };
  console.log(JSON.stringify(emf));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, status: 'PENDING' }),
  };
};
