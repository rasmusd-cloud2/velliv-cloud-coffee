import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export interface SimulatorConstructProps {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly botUsername: string;
  readonly botPasswordSecret: secretsmanager.Secret;
  readonly apiEndpoint: string;
  /**
   * Whether the EventBridge schedule that fires the simulator every minute
   * is enabled. Default false — keeps the stack idle (and cheap) until the
   * workshop instructor opts in via `-c enableSimulator=true`.
   */
  readonly scheduleEnabled?: boolean;
}

export class SimulatorConstruct extends Construct {
  public readonly simulator: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: SimulatorConstructProps) {
    super(scope, id);

    const stackName = cdk.Stack.of(this).stackName;

    const simLogs = new logs.LogGroup(this, 'SimulatorLogGroup', {
      logGroupName: `/aws/lambda/${stackName}-TrafficSimulator`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.simulator = new lambdaNodejs.NodejsFunction(this, 'TrafficSimulator', {
      functionName: `${stackName}-TrafficSimulator`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(
        __dirname,
        '..',
        '..',
        'src',
        'traffic-simulator',
        'index.ts',
      ),
      handler: 'handler',
      logGroup: simLogs,
      timeout: cdk.Duration.seconds(55),
      memorySize: 512,
      environment: {
        API_ENDPOINT: props.apiEndpoint,
        USER_POOL_ID: props.userPool.userPoolId,
        CLIENT_ID: props.userPoolClient.userPoolClientId,
        BOT_SECRET_ARN: props.botPasswordSecret.secretArn,
        BOT_USERNAME: props.botUsername,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        format: lambdaNodejs.OutputFormat.ESM,
        target: 'node20',
        mainFields: ['module', 'main'],
        // Simulator does not use the shared-utils layer; no externals needed
        // beyond the runtime-provided AWS SDK v3.
        externalModules: ['@aws-sdk/*'],
        sourceMap: true,
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });

    props.botPasswordSecret.grantRead(this.simulator);
    this.simulator.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminInitiateAuth'],
        resources: [props.userPool.userPoolArn],
      }),
    );

    new events.Rule(this, 'SimulatorSchedule', {
      // Default-bus EventBridge rule names must be unique per region/account.
      // Suffix with stack name (already includes developer namespace).
      ruleName: `${stackName}-TrafficSimulatorSchedule`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(this.simulator)],
      enabled: props.scheduleEnabled ?? false,
    });
  }
}
