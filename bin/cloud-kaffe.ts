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

new CloudKaffeStack(app, 'CloudKaffeStack', {
  env: { account, region },
  description: 'Cloud Kaffen - AWS CDK serverless masterclass workshop',
  domainPrefix: app.node.tryGetContext('domainPrefix'),
  archiveRetentionDays:
    Number(app.node.tryGetContext('archiveRetentionDays')) || 3,
  demoPassword: app.node.tryGetContext('demoPassword') ?? 'Kaffe123!',
  alertEmail: app.node.tryGetContext('alertEmail'),
});

cdk.Tags.of(app).add('Project', 'CloudKaffe');

app.synth();
