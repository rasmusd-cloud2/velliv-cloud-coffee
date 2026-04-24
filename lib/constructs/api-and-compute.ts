import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
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
 * Compute + API plane.
 *
 * Lambdas use NodejsFunction (esbuild) so TypeScript source + @aws-sdk/*
 * deps (including s3-request-presigner not in Lambda managed runtime) get
 * bundled automatically. `shared-utils` is marked external so it resolves
 * at runtime from the /opt/nodejs layer via NODE_PATH.
 */
export class ApiAndComputeConstruct extends Construct {
  public readonly api: apigw.RestApi;
  public readonly orderReceiver: lambdaNodejs.NodejsFunction;
  public readonly orderProcessor: lambdaNodejs.NodejsFunction;
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

    // Shared ESM layer - stays as .mjs at /opt/nodejs/node_modules/shared-utils
    this.sharedLayer = new lambda.LayerVersion(this, 'SharedUtilsLayer', {
      layerVersionName: 'CloudKaffeSharedUtils',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', '..', 'src', 'shared-layer'),
      ),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'Shared ESM utilities for CloudKaffe Lambdas',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Common bundling config: ESM output, AWS SDK external (in runtime),
    // shared-utils external (resolved from layer via NODE_PATH).
    const commonBundling: lambdaNodejs.BundlingOptions = {
      format: lambdaNodejs.OutputFormat.ESM,
      target: 'node20',
      mainFields: ['module', 'main'],
      externalModules: ['@aws-sdk/*', 'shared-utils'],
      sourceMap: true,
      // ESM banner: required for `require`/`__dirname` shims when esbuild
      // emits ESM but a bundled dep still uses CommonJS idioms.
      banner:
        "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    };

    // OrderReceiver
    const receiverLogs = new logs.LogGroup(this, 'OrderReceiverLogGroup', {
      logGroupName: `/aws/lambda/${stackName}-OrderReceiver`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.orderReceiver = new lambdaNodejs.NodejsFunction(
      this,
      'OrderReceiver',
      {
        functionName: `${stackName}-OrderReceiver`,
        runtime: lambda.Runtime.NODEJS_20_X,
        entry: path.join(
          __dirname,
          '..',
          '..',
          'src',
          'order-receiver',
          'index.ts',
        ),
        handler: 'handler',
        tracing: lambda.Tracing.ACTIVE,
        layers: [this.sharedLayer],
        logGroup: receiverLogs,
        timeout: cdk.Duration.seconds(10),
        memorySize: 256,
        environment: {
          ORDERS_TABLE: props.ordersTable.tableName,
          EVENT_BUS_NAME: props.eventBus.eventBusName,
          POWERTOOLS_METRICS_NAMESPACE: 'CloudKaffe',
          NODE_OPTIONS: '--enable-source-maps',
        },
        bundling: commonBundling,
      },
    );
    props.ordersTable.grantWriteData(this.orderReceiver);
    props.eventBus.grantPutEventsTo(this.orderReceiver);

    // OrderProcessor (bundles s3-request-presigner, not in managed runtime)
    const processorLogs = new logs.LogGroup(this, 'OrderProcessorLogGroup', {
      logGroupName: `/aws/lambda/${stackName}-OrderProcessor`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.orderProcessor = new lambdaNodejs.NodejsFunction(
      this,
      'OrderProcessor',
      {
        functionName: `${stackName}-OrderProcessor`,
        runtime: lambda.Runtime.NODEJS_20_X,
        entry: path.join(
          __dirname,
          '..',
          '..',
          'src',
          'order-processor',
          'index.ts',
        ),
        handler: 'handler',
        tracing: lambda.Tracing.ACTIVE,
        layers: [this.sharedLayer],
        logGroup: processorLogs,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        environment: {
          ORDERS_TABLE: props.ordersTable.tableName,
          RECEIPTS_BUCKET: props.receiptsBucket.bucketName,
          NODE_OPTIONS: '--enable-source-maps',
        },
        bundling: {
          ...commonBundling,
          // Only externalize the AWS SDK client-* packages (in managed
          // runtime). `@aws-sdk/s3-request-presigner` is NOT in the runtime
          // and MUST be bundled - this narrower pattern lets esbuild bundle it.
          externalModules: ['@aws-sdk/client-*', 'shared-utils'],
        },
      },
    );
    this.orderProcessor.addEventSource(
      new SqsEventSource(props.orderQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );
    props.ordersTable.grantWriteData(this.orderProcessor);
    props.receiptsBucket.grantReadWrite(this.orderProcessor);

    // REST API with Cognito authorizer + request validator
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

    // Composite alarm: 5XX rate > 5% AND request count >= 10
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
