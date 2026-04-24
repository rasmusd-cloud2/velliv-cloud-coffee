import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

export interface ApiAndComputeConstructProps {
  readonly userPool: cognito.UserPool;
  readonly ordersTable: dynamodb.Table;
  readonly eventBus: events.EventBus;
  readonly orderQueue: sqs.Queue;
  readonly receiptsBucket: s3.Bucket;
}

/**
 * Compute + API plane:
 *   - SharedUtilsLayer (ESM layer via /opt/nodejs/node_modules/shared-utils)
 *   - OrderReceiver Lambda (X-Ray, EMF via stdout, chaos: FATAL_ERROR + SLOW_BREW)
 *   - OrderProcessor Lambda (chaos: POISON_PILL -> DLQ; DDB update + S3 put + presigned URL)
 *   - REST API /orders POST (Cognito authorizer + schema validation + X-Ray + CORS)
 *   - Composite alarm (5XX rate > 5% AND request count >= 10)
 *
 * Explicit log groups per Lambda with RemovalPolicy.DESTROY so cdk destroy
 * leaves zero orphaned log groups. Do NOT use Lambda Function.logRetention
 * prop - it orphans log groups on destroy.
 */
export class ApiAndComputeConstruct extends Construct {
  public readonly api: apigw.RestApi;
  public readonly orderReceiver: lambda.Function;
  public readonly orderProcessor: lambda.Function;
  public readonly sharedLayer: lambda.LayerVersion;

  public get apiEndpoint(): string {
    return this.api.url;
  }

  constructor(
    scope: Construct,
    id: string,
    props: ApiAndComputeConstructProps,
  ) {
    super(scope, id);

    const stackName = cdk.Stack.of(this).stackName;

    // ---- Shared Lambda layer (ESM) ----
    this.sharedLayer = new lambda.LayerVersion(this, 'SharedUtilsLayer', {
      layerVersionName: 'CloudKaffeSharedUtils',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', '..', 'src', 'shared-layer'),
      ),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description:
        'Shared ESM utilities for CloudKaffe Lambdas (formatTimestamp, etc.)',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---- OrderReceiver Lambda ----
    const receiverLogs = new logs.LogGroup(this, 'OrderReceiverLogGroup', {
      logGroupName: `/aws/lambda/${stackName}-OrderReceiver`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.orderReceiver = new lambda.Function(this, 'OrderReceiver', {
      functionName: `${stackName}-OrderReceiver`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', '..', 'src', 'order-receiver'),
      ),
      tracing: lambda.Tracing.ACTIVE,
      layers: [this.sharedLayer],
      logGroup: receiverLogs,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        ORDERS_TABLE: props.ordersTable.tableName,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        POWERTOOLS_METRICS_NAMESPACE: 'CloudKaffe',
      },
    });
    props.ordersTable.grantWriteData(this.orderReceiver);
    props.eventBus.grantPutEventsTo(this.orderReceiver);

    // ---- OrderProcessor Lambda ----
    const processorLogs = new logs.LogGroup(this, 'OrderProcessorLogGroup', {
      logGroupName: `/aws/lambda/${stackName}-OrderProcessor`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.orderProcessor = new lambda.Function(this, 'OrderProcessor', {
      functionName: `${stackName}-OrderProcessor`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', '..', 'src', 'order-processor'),
      ),
      tracing: lambda.Tracing.ACTIVE,
      layers: [this.sharedLayer],
      logGroup: processorLogs,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ORDERS_TABLE: props.ordersTable.tableName,
        RECEIPTS_BUCKET: props.receiptsBucket.bucketName,
      },
    });
    this.orderProcessor.addEventSource(
      new SqsEventSource(props.orderQueue, { batchSize: 1, reportBatchItemFailures: true }),
    );
    props.ordersTable.grantWriteData(this.orderProcessor);
    props.receiptsBucket.grantReadWrite(this.orderProcessor);

    // ---- REST API with Cognito authorizer + request validator ----
    this.api = new apigw.RestApi(this, 'OrdersApi', {
      restApiName: 'CloudKaffeOrdersApi',
      description: 'Cloud Kaffen order intake API',
      deployOptions: {
        stageName: 'v1',
        tracingEnabled: true,
        dataTraceEnabled: true,
        loggingLevel: apigw.MethodLoggingLevel.INFO,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(
      this,
      'CognitoAuthorizer',
      {
        cognitoUserPools: [props.userPool],
        authorizerName: 'CloudKaffeCognitoAuth',
      },
    );

    const orderModel = this.api.addModel('OrderModel', {
      modelName: 'Order',
      contentType: 'application/json',
      schema: {
        schema: apigw.JsonSchemaVersion.DRAFT4,
        title: 'Order',
        type: apigw.JsonSchemaType.OBJECT,
        required: ['coffeeType', 'size'],
        properties: {
          coffeeType: { type: apigw.JsonSchemaType.STRING, minLength: 1 },
          size: { type: apigw.JsonSchemaType.STRING, minLength: 1 },
        },
      },
    });

    const validator = this.api.addRequestValidator('BodyValidator', {
      validateRequestBody: true,
      validateRequestParameters: false,
    });

    const orders = this.api.root.addResource('orders');
    orders.addMethod(
      'POST',
      new apigw.LambdaIntegration(this.orderReceiver, { proxy: true }),
      {
        authorizer,
        authorizationType: apigw.AuthorizationType.COGNITO,
        requestValidator: validator,
        requestModels: { 'application/json': orderModel },
      },
    );

    // ---- Composite alarm: 5XX rate > 5% AND request count >= 10 ----
    const m5xx = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '5XXError',
      dimensionsMap: { ApiName: this.api.restApiName, Stage: 'v1' },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });
    const mCount = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'Count',
      dimensionsMap: { ApiName: this.api.restApiName, Stage: 'v1' },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });
    const errorRate = new cloudwatch.MathExpression({
      expression: '(m5xx / mCount) * 100',
      usingMetrics: { m5xx, mCount },
      period: cdk.Duration.minutes(1),
      label: 'API 5XX Error Rate (%)',
    });
    const highErrorRate = new cloudwatch.Alarm(this, 'HighErrorRateAlarm', {
      alarmName: 'CloudKaffe-API-HighErrorRate',
      metric: errorRate,
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const enoughTraffic = new cloudwatch.Alarm(this, 'EnoughTrafficAlarm', {
      alarmName: 'CloudKaffe-API-EnoughTraffic',
      metric: mCount,
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.CompositeAlarm(this, 'ApiErrorSpikeComposite', {
      compositeAlarmName: 'CloudKaffe-API-ErrorSpike',
      alarmDescription:
        'Fires when API GW 5XX rate > 5% AND request count >= 10 in 1 min',
      alarmRule: cloudwatch.AlarmRule.allOf(
        cloudwatch.AlarmRule.fromAlarm(
          highErrorRate,
          cloudwatch.AlarmState.ALARM,
        ),
        cloudwatch.AlarmRule.fromAlarm(
          enoughTraffic,
          cloudwatch.AlarmState.ALARM,
        ),
      ),
    });
  }
}
