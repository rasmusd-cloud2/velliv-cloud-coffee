import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AuthConstruct } from './constructs/auth';
import { DatabaseAndEventsConstruct } from './constructs/database-and-events';
import { ApiAndComputeConstruct } from './constructs/api-and-compute';
import { SimulatorConstruct } from './constructs/simulator';
import { DashboardConstruct } from './constructs/dashboard';

export interface CloudKaffeStackProps extends cdk.StackProps {
  readonly domainPrefix?: string;
  readonly archiveRetentionDays: number;
  readonly demoPassword: string;
  readonly alertEmail?: string;
}

export class CloudKaffeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CloudKaffeStackProps) {
    super(scope, id, props);

    // Construct wiring order: Auth -> DataAndEvents -> ApiAndCompute -> Simulator
    const auth = new AuthConstruct(this, 'Auth', {
      domainPrefix: props.domainPrefix,
      demoPassword: props.demoPassword,
    });

    const dataAndEvents = new DatabaseAndEventsConstruct(
      this,
      'DataAndEvents',
      {
        archiveRetentionDays: props.archiveRetentionDays,
        alertEmail: props.alertEmail,
      },
    );

    const apiAndCompute = new ApiAndComputeConstruct(this, 'ApiAndCompute', {
      userPool: auth.userPool,
      ordersTable: dataAndEvents.ordersTable,
      eventBus: dataAndEvents.eventBus,
      orderQueue: dataAndEvents.orderQueue,
      receiptsBucket: dataAndEvents.receiptsBucket,
    });

    const sim = new SimulatorConstruct(this, 'Simulator', {
      userPool: auth.userPool,
      userPoolClient: auth.userPoolClient,
      botUsername: auth.botUsername,
      botPasswordSecret: auth.botPasswordSecret,
      apiEndpoint: apiAndCompute.apiEndpoint,
    });

    const dashboard = new DashboardConstruct(this, 'Dashboard', {
      api: apiAndCompute.api,
      orderReceiver: apiAndCompute.orderReceiver,
      orderProcessor: apiAndCompute.orderProcessor,
      simulator: sim.simulator,
      ordersTable: dataAndEvents.ordersTable,
      orderQueue: dataAndEvents.orderQueue,
      orderDlq: dataAndEvents.orderDlq,
      eventBus: dataAndEvents.eventBus,
      orderCreatedRule: dataAndEvents.orderCreatedRule,
      errorSpikeAlarm: apiAndCompute.errorSpikeAlarm,
      dlqAlarm: dataAndEvents.dlqAlarm,
    });

    // Outputs for workshop attendees
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: apiAndCompute.apiEndpoint,
      description: 'POST /orders API endpoint',
    });
    new cdk.CfnOutput(this, 'HostedUiUrl', {
      value: `https://${auth.domainPrefix}.auth.${this.region}.amazoncognito.com/login?client_id=${auth.userPoolClient.userPoolClientId}&response_type=token&redirect_uri=https://example.com`,
      description: 'Cognito Hosted UI login URL',
    });
    new cdk.CfnOutput(this, 'DemoUserCredentials', {
      value: `demoUser / ${props.demoPassword}`,
      description: 'Workshop demo user (Module 4)',
    });
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: dashboard.dashboardUrl,
      description: 'CloudWatch workshop dashboard',
    });
  }
}
