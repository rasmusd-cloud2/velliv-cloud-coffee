#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CloudKaffeStack } from '../lib/cloud-kaffe-stack';

const app = new cdk.App();

const account =
  process.env.CDK_DEFAULT_ACCOUNT ?? app.node.tryGetContext('account');
const region =
  process.env.CDK_DEFAULT_REGION ??
  app.node.tryGetContext('region') ??
  'eu-north-1';

if (!account) {
  throw new Error(
    'AWS account not resolved. Set CDK_DEFAULT_ACCOUNT env var, use AWS_PROFILE, or pass -c account=XXXXXXXXXXXX',
  );
}

// Per-developer namespace so multiple team members can deploy into the same
// account without resource-name collisions (DDB tables, EventBus, SQS queues,
// Cognito Hosted UI domain, alarms, dashboards, etc).
//   cdk deploy -c developer=alice
// Falls back to USER / USERNAME env so local CLI deploys "just work".
const rawDeveloper =
  app.node.tryGetContext('developer') ??
  process.env.DEVELOPER ??
  process.env.USER ??
  process.env.USERNAME;

if (!rawDeveloper) {
  throw new Error(
    'Developer namespace not resolved. Pass -c developer=<name> or set DEVELOPER/USER env var.',
  );
}

const developer = String(rawDeveloper).toLowerCase().replace(/[^a-z0-9]/g, '');
if (!developer || developer.length < 2 || developer.length > 16) {
  throw new Error(
    `Invalid developer namespace "${rawDeveloper}". Must be 2-16 chars after lowercasing and stripping non-alphanumerics.`,
  );
}

new CloudKaffeStack(app, `CloudKaffeStack-${developer}`, {
  env: { account, region },
  description: `Cloud Kaffen workshop stack (developer=${developer})`,
  developer,
  domainPrefix: app.node.tryGetContext('domainPrefix'),
  archiveRetentionDays:
    Number(app.node.tryGetContext('archiveRetentionDays')) || 3,
  demoPassword: app.node.tryGetContext('demoPassword') ?? 'Kaffe123!',
  alertEmail: app.node.tryGetContext('alertEmail'),
  // Traffic simulator schedule defaults to disabled. Opt in with
  // `-c enableSimulator=true` (or any truthy value).
  enableSimulator: parseEnableSimulator(
    app.node.tryGetContext('enableSimulator'),
  ),
});

cdk.Tags.of(app).add('Project', 'CloudKaffe');
cdk.Tags.of(app).add('Developer', developer);

app.synth();

function parseEnableSimulator(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  return ['true', '1', 'yes', 'on'].includes(String(raw).toLowerCase());
}
