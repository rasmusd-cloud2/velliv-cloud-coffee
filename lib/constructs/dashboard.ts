import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as logs from 'aws-cdk-lib/aws-logs';

export interface DashboardConstructProps {
  /**
   * Per-developer namespace suffix. Used for dashboard name + EMF metric
   * search so multiple team-member stacks render isolated dashboards.
   */
  readonly developer: string;
  readonly api: apigw.RestApi;
  readonly orderReceiver: lambda.IFunction;
  readonly orderProcessor: lambda.IFunction;
  readonly simulator: lambda.IFunction;
  readonly ordersTable: dynamodb.Table;
  readonly orderQueue: sqs.Queue;
  readonly orderDlq: sqs.Queue;
  readonly eventBus: events.EventBus;
  readonly orderCreatedRule: events.Rule;
  readonly errorSpikeAlarm: cloudwatch.IAlarm;
  readonly dlqAlarm: cloudwatch.IAlarm;
}

/**
 * Workshop dashboard. One screen the room can watch while chaos flows.
 * Layout: top row = pulse (orders, coffee types), mid = errors + latency,
 * bottom = async plane + alarms + log insights.
 */
export class DashboardConstruct extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: DashboardConstructProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const apiDims = { ApiName: props.api.restApiName, Stage: 'v1' };
    const period = cdk.Duration.minutes(1);

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `CloudKaffe-Workshop-${props.developer}`,
      defaultInterval: cdk.Duration.hours(1),
      periodOverride: cloudwatch.PeriodOverride.AUTO,
    });

    // ---- Header ----
    const header = new cloudwatch.TextWidget({
      markdown: [
        `# Cloud Kaffen — Live Activity (developer: \`${props.developer}\`)`,
        'Traffic simulator fires every minute. Chaos types injected: `FATAL_ERROR` (5XX), `SLOW_BREW` (latency), `POISON_PILL` (DLQ), `schemaInvalid` (4XX at API GW validator).',
        '',
        `Region: **${stack.region}** · Account: **${stack.account}** · Stack: **${stack.stackName}**`,
      ].join('\n'),
      width: 24,
      height: 3,
    });

    // ---- Orders/min: API GW Count + OrderReceiver invocations ----
    const ordersPerMin = new cloudwatch.GraphWidget({
      title: 'Orders / min (API GW Count vs OrderReceiver invocations)',
      width: 12,
      height: 6,
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/ApiGateway',
          metricName: 'Count',
          dimensionsMap: apiDims,
          statistic: 'Sum',
          period,
          label: 'API requests',
        }),
        props.orderReceiver.metricInvocations({ period, label: 'Receiver invocations' }),
      ],
      leftYAxis: { min: 0 },
      view: cloudwatch.GraphWidgetView.TIME_SERIES,
    });

    // ---- Coffee sold by type (EMF, unknown dimension values → SEARCH) ----
    // Namespace is per-developer so each stack's dashboard shows only its
    // own coffee sales — keeps workshop attendees from cross-pollinating.
    const emfNamespace = `CloudKaffe-${props.developer}`;
    const coffeeByType = new cloudwatch.GraphWidget({
      title: `Coffees sold by type (EMF ${emfNamespace}/CoffeeSold)`,
      width: 12,
      height: 6,
      left: [
        new cloudwatch.MathExpression({
          expression: `SEARCH('{${emfNamespace},CoffeeType} MetricName="CoffeeSold"', 'Sum', 60)`,
          label: '',
          period,
        }),
      ],
      leftYAxis: { min: 0 },
      stacked: true,
    });

    // ---- 5XX error rate % ----
    const m5xx = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '5XXError',
      dimensionsMap: apiDims,
      statistic: 'Sum',
      period,
    });
    const m4xx = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '4XXError',
      dimensionsMap: apiDims,
      statistic: 'Sum',
      period,
    });
    const mCount = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'Count',
      dimensionsMap: apiDims,
      statistic: 'Sum',
      period,
    });
    const errorRatePct = new cloudwatch.MathExpression({
      expression: 'IF(mCount > 0, (m5xx / mCount) * 100, 0)',
      usingMetrics: { m5xx, mCount },
      label: '5XX rate (%)',
      period,
    });
    const errorWidget = new cloudwatch.GraphWidget({
      title: 'API Gateway errors (5XX rate %, 4XX, 5XX counts)',
      width: 12,
      height: 6,
      left: [errorRatePct],
      leftYAxis: { min: 0, max: 100, label: '%' },
      right: [m4xx, m5xx],
      rightYAxis: { min: 0, label: 'count' },
    });

    // ---- Lambda duration p50/p99 (receiver + processor) ----
    const latencyWidget = new cloudwatch.GraphWidget({
      title: 'Lambda duration (p50 / p99, ms)',
      width: 12,
      height: 6,
      left: [
        props.orderReceiver.metricDuration({ statistic: 'p50', period, label: 'Receiver p50' }),
        props.orderReceiver.metricDuration({ statistic: 'p99', period, label: 'Receiver p99' }),
        props.orderProcessor.metricDuration({ statistic: 'p50', period, label: 'Processor p50' }),
        props.orderProcessor.metricDuration({ statistic: 'p99', period, label: 'Processor p99' }),
      ],
      leftYAxis: { min: 0, label: 'ms' },
    });

    // ---- Lambda errors (all 3) ----
    const lambdaErrors = new cloudwatch.GraphWidget({
      title: 'Lambda errors (invocations failed)',
      width: 12,
      height: 6,
      left: [
        props.orderReceiver.metricErrors({ period, label: 'OrderReceiver' }),
        props.orderProcessor.metricErrors({ period, label: 'OrderProcessor' }),
        props.simulator.metricErrors({ period, label: 'TrafficSimulator' }),
      ],
      leftYAxis: { min: 0 },
    });

    // ---- SQS + DLQ depth ----
    const queueWidget = new cloudwatch.GraphWidget({
      title: 'SQS depth — main queue vs DLQ (POISON_PILL lands here)',
      width: 12,
      height: 6,
      left: [
        props.orderQueue.metricApproximateNumberOfMessagesVisible({
          period,
          statistic: 'Maximum',
          label: 'OrderProcessorQueue visible',
        }),
        props.orderDlq.metricApproximateNumberOfMessagesVisible({
          period,
          statistic: 'Maximum',
          label: 'DLQ visible',
        }),
      ],
      leftYAxis: { min: 0 },
    });

    // ---- EventBridge matched + DDB writes ----
    const eventsAndDdb = new cloudwatch.GraphWidget({
      title: 'EventBridge rule matches + DDB consumed writes',
      width: 12,
      height: 6,
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/Events',
          metricName: 'MatchedEvents',
          dimensionsMap: {
            EventBusName: props.eventBus.eventBusName,
            RuleName: props.orderCreatedRule.ruleName,
          },
          statistic: 'Sum',
          period,
          label: 'OrderCreated matches',
        }),
      ],
      right: [
        props.ordersTable.metricConsumedWriteCapacityUnits({
          period,
          label: 'DDB write capacity units',
        }),
      ],
      leftYAxis: { min: 0 },
      rightYAxis: { min: 0 },
    });

    // ---- Alarm status (composite 5XX + DLQ) ----
    const alarmWidget = new cloudwatch.AlarmStatusWidget({
      title: 'Alarms',
      width: 12,
      height: 6,
      alarms: [props.errorSpikeAlarm, props.dlqAlarm],
    });

    // ---- Log Insights: errors from OrderReceiver ----
    const receiverLogGroup = logs.LogGroup.fromLogGroupName(
      this,
      'ReceiverLogRef',
      `/aws/lambda/${stack.stackName}-OrderReceiver`,
    );
    const processorLogGroup = logs.LogGroup.fromLogGroupName(
      this,
      'ProcessorLogRef',
      `/aws/lambda/${stack.stackName}-OrderProcessor`,
    );
    const errorLogsWidget = new cloudwatch.LogQueryWidget({
      title: 'Recent errors — OrderReceiver + OrderProcessor',
      width: 24,
      height: 8,
      logGroupNames: [receiverLogGroup.logGroupName, processorLogGroup.logGroupName],
      queryLines: [
        'fields @timestamp, @log, @message',
        'filter @message like /ERROR/ or level = "ERROR"',
        'sort @timestamp desc',
        'limit 50',
      ],
      view: cloudwatch.LogQueryVisualizationType.TABLE,
    });

    this.dashboard.addWidgets(header);
    this.dashboard.addWidgets(ordersPerMin, coffeeByType);
    this.dashboard.addWidgets(errorWidget, latencyWidget);
    this.dashboard.addWidgets(lambdaErrors, queueWidget);
    this.dashboard.addWidgets(eventsAndDdb, alarmWidget);
    this.dashboard.addWidgets(errorLogsWidget);
  }

  public get dashboardUrl(): string {
    const stack = cdk.Stack.of(this);
    return `https://${stack.region}.console.aws.amazon.com/cloudwatch/home?region=${stack.region}#dashboards:name=${this.dashboard.dashboardName}`;
  }
}
