import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as targets from 'aws-cdk-lib/aws-events-targets';

export interface DatabaseAndEventsConstructProps {
  readonly archiveRetentionDays: number;
  readonly alertEmail?: string;
}

/**
 * Data plane + async messaging:
 *   - DynamoDB OrdersTable (PK orderId, GSI coffeeType, Streams NEW_IMAGE, TTL expiresAt)
 *   - S3 OrderReceiptsBucket (block public, no EventBridge notifications - see Codex #6)
 *   - EventBridge CloudKaffeBus + archive (retention overridable via cdk context)
 *   - SQS OrderProcessorQueue + DLQ (maxReceiveCount 3)
 *   - SNS OrderAlertsTopic (DLQ depth alarm target)
 *   - CloudWatch DLQ depth alarm
 */
export class DatabaseAndEventsConstruct extends Construct {
  public readonly ordersTable: dynamodb.Table;
  public readonly receiptsBucket: s3.Bucket;
  public readonly eventBus: events.EventBus;
  public readonly orderQueue: sqs.Queue;
  public readonly orderDlq: sqs.Queue;
  public readonly alertsTopic: sns.Topic;

  constructor(
    scope: Construct,
    id: string,
    props: DatabaseAndEventsConstructProps,
  ) {
    super(scope, id);

    // ---- DynamoDB ----
    this.ordersTable = new dynamodb.Table(this, 'OrdersTable', {
      tableName: 'CloudKaffeOrders',
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.ordersTable.addGlobalSecondaryIndex({
      indexName: 'CoffeeTypeIndex',
      partitionKey: { name: 'coffeeType', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---- S3 receipts bucket ----
    this.receiptsBucket = new s3.Bucket(this, 'OrderReceiptsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      eventBridgeEnabled: false, // Codex #6 - no consumer in this stack; disabled to reduce noise
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---- EventBridge custom bus + archive ----
    this.eventBus = new events.EventBus(this, 'CloudKaffeBus', {
      eventBusName: 'CloudKaffeBus',
    });
    this.eventBus.archive('CloudKaffeArchive', {
      archiveName: 'CloudKaffeArchive',
      retention: cdk.Duration.days(props.archiveRetentionDays),
      eventPattern: { account: [cdk.Stack.of(this).account] },
    });

    // ---- SQS queue + DLQ ----
    this.orderDlq = new sqs.Queue(this, 'OrderProcessorDLQ', {
      queueName: 'CloudKaffeOrderProcessor-DLQ',
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.orderQueue = new sqs.Queue(this, 'OrderProcessorQueue', {
      queueName: 'CloudKaffeOrderProcessor',
      visibilityTimeout: cdk.Duration.seconds(30),
      deadLetterQueue: { queue: this.orderDlq, maxReceiveCount: 3 },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---- EventBridge rule: OrderCreated -> SQS ----
    new events.Rule(this, 'OrderCreatedRule', {
      eventBus: this.eventBus,
      ruleName: 'OrderCreatedToProcessor',
      eventPattern: { detailType: ['OrderCreated'] },
      targets: [new targets.SqsQueue(this.orderQueue)],
    });

    // ---- SNS alerts topic ----
    this.alertsTopic = new sns.Topic(this, 'OrderAlertsTopic', {
      topicName: 'CloudKaffeOrderAlerts',
      displayName: 'Cloud Kaffen Alerts',
    });
    if (props.alertEmail) {
      this.alertsTopic.addSubscription(
        new subscriptions.EmailSubscription(props.alertEmail),
      );
    }

    // ---- DLQ depth alarm ----
    const dlqAlarm = new cloudwatch.Alarm(this, 'DLQDepthAlarm', {
      alarmName: 'CloudKaffe-DLQ-NotEmpty',
      alarmDescription:
        'DLQ has >=1 message - order processor failed 3 retries (POISON_PILL chaos or real failure)',
      metric: this.orderDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(new cwactions.SnsAction(this.alertsTopic));
  }
}
