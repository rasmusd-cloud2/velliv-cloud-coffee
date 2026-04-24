/**
 * OrderReceiver Lambda (TypeScript, bundled by NodejsFunction/esbuild)
 *
 * Chaos branches:
 *   - coffeeType === 'FATAL_ERROR': throws (API GW 500)
 *   - coffeeType === 'SLOW_BREW':   4s delay before success
 *   - anything else:                200 OK, write + publish
 *
 * EMF metric: Namespace=CloudKaffe, Dimension=CoffeeType, Metric=CoffeeSold (Count)
 */

import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import { formatTimestamp, generateOrderId } from 'shared-utils';

const ddb = new DynamoDBClient({});
const eb = new EventBridgeClient({});

const ORDERS_TABLE = process.env.ORDERS_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

interface OrderBody {
  coffeeType: string;
  size: string;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const body = JSON.parse(event.body ?? '{}') as Partial<OrderBody>;
  const { coffeeType, size } = body;

  if (!coffeeType || !size) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'coffeeType and size required' }),
    };
  }

  // Chaos branches
  if (coffeeType === 'FATAL_ERROR') {
    throw new Error('Simulated Database Crash');
  }
  if (coffeeType === 'SLOW_BREW') {
    await new Promise((r) => setTimeout(r, 4000));
  }

  const orderId = generateOrderId();
  const now = formatTimestamp();
  const ttl = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

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

  // EMF metric emit via stdout
  console.log(
    JSON.stringify({
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
    }),
  );

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, status: 'PENDING' }),
  };
};
