# Cloud Kaffen (velliv-cloud-coffee)

AWS CDK v2 TypeScript project for a full-day AWS masterclass workshop. Serverless order-management system with deliberately-injected chaos (traffic simulator, FATAL_ERROR, SLOW_BREW, POISON_PILL) that drives DLQs, alarms, and EMF metrics visible in CloudWatch from the moment you deploy.

See `docs/workshop-agenda.md` for the workshop agenda (Danish), `docs/infrastructure.md` for the original resource spec, and the canonical design doc in `~/.gstack/projects/rasmusd-cloud2-velliv-cloud-coffee/rasmu-main-design-20260424-100858.md`.

## Prereqs

- Node 20+
- AWS CLI v2 configured (`aws configure` or `AWS_PROFILE`)
- AWS CDK CLI v2 (`npm install -g aws-cdk`)
- Admin IAM role on the target AWS account (no SCPs blocking Cognito domain creation, EventBridge archive, IAM role creation, etc.)
- Bootstrapped AWS account: `cdk bootstrap aws://<ACCOUNT>/<REGION>`

## Setup

```bash
git clone https://github.com/rasmusd-cloud2/velliv-cloud-coffee.git
cd velliv-cloud-coffee
npm install
```

## Deploy

```bash
# Option 1: via AWS_PROFILE (recommended)
AWS_PROFILE=myprofile cdk deploy

# Option 2: explicit context
cdk deploy -c account=123456789012 -c region=eu-north-1

# Optional flags
cdk deploy -c domainPrefix=cloud-kaffe-alice        # override Cognito Hosted UI prefix
cdk deploy -c archiveRetentionDays=7                # override EventBridge archive retention (default 3)
cdk deploy -c demoPassword=MyDemoPass123            # override demoUser password (default Kaffe123!)
cdk deploy -c alertEmail=you@example.com            # subscribe email to SNS alerts topic
```

Expected deploy time: **12–15 min cold** (Cognito User Pool + domain + API Gateway stage dominate).

## What gets deployed

- Cognito User Pool with Hosted UI, bot user (for simulator) + demoUser (for workshop attendees)
- DynamoDB `CloudKaffeOrders` table (PAY_PER_REQUEST, GSI on `coffeeType`, Streams NEW_IMAGE, TTL `expiresAt`)
- S3 `OrderReceiptsBucket` (block public, auto-delete on destroy)
- EventBridge `CloudKaffeBus` + 3-day archive + OrderCreated rule
- SQS `OrderProcessorQueue` + DLQ + depth alarm
- SNS `OrderAlertsTopic`
- 3 Lambdas: OrderReceiver, OrderProcessor, TrafficSimulator
- API Gateway REST API v1 with Cognito authorizer + schema validator + X-Ray
- CloudWatch composite alarm (5XX rate > 5% AND request count >= 10)
- EventBridge rule scheduling TrafficSimulator every 1 minute

## Workshop module pointers

Cross-referenced with `docs/workshop-agenda.md`.

### Module 1 — Observability

- EMF `CoffeeSold` metric by `CoffeeType` dimension: CloudWatch → Metrics → CloudKaffe namespace
- Log Insights query for errors:
  ```
  fields @timestamp, @message
  | filter @message like /ERROR/
  | sort @timestamp desc
  ```
- Composite alarm `CloudKaffe-API-ErrorSpike`: fires when FATAL_ERROR chaos drives 5XX rate > 5% AND request count >= 10 in 1 min
- DLQ depth alarm `CloudKaffe-DLQ-NotEmpty`: fires when POISON_PILL chaos fills DLQ

### Module 2 — Compute & API

- Lambda init vs invoke duration visible in each Lambda's log group
- API Gateway console → `CloudKaffeOrdersApi` → Stages → `v1`

### Module 3 — IaC (CDK & CFN)

- `npx cdk synth` prints the full CloudFormation template
- `npx cdk diff` (after deploy) shows empty — idempotent
- CloudFormation console → `CloudKaffeStack` → Events / Resources tabs

### Module 4 — Auth (Cognito)

- CDK output `HostedUiUrl` prints the full Hosted UI login URL
- Login as: `demoUser / Kaffe123!` (override via `-c demoPassword=X`)
- Copy the JWT from the redirect URL hash, paste into https://jwt.io
- Test POST /orders:
  ```bash
  # Without token - expect 401
  curl -X POST <ApiEndpoint>orders -d '{"coffeeType":"Latte","size":"Large"}'

  # With valid body + JWT - expect 200
  curl -X POST <ApiEndpoint>orders \
    -H "Authorization: Bearer <YOUR_JWT>" \
    -H "Content-Type: application/json" \
    -d '{"coffeeType":"Latte","size":"Large"}'

  # With bad schema + JWT - expect 400
  curl -X POST <ApiEndpoint>orders \
    -H "Authorization: Bearer <YOUR_JWT>" \
    -H "Content-Type: application/json" \
    -d '{"size":"Large"}'
  ```

### Module 5 — Data & Events

- DynamoDB console → `CloudKaffeOrders` → Items. Demo Query (cheap) vs Scan (expensive).
- SQS console → `CloudKaffeOrderProcessor` → Visibility Timeout, DLQ redrive
- EventBridge console → Buses → `CloudKaffeBus` → Rules → `OrderCreatedToProcessor`
- Event Archive → `CloudKaffeArchive` → Replay. Receipt keys are **deterministic** (`receipts/${orderId}.json`) so replay reprocesses in place — no duplicate files.
- OrderProcessor logs show `s3Uri` + `presignHint` per order; run the printed `aws s3 presign` command to open the receipt.

## Destroy

```bash
cdk destroy
```

Expected 5–8 min. Archive deletion is the slow step. Cleaner than before thanks to:
- 3-day archive retention (shorter than demo default of 30 days)
- Explicit log groups with `RemovalPolicy.DESTROY`
- S3 bucket `autoDeleteObjects: true`
- Cognito user pool + cascade-deleted bot/demo users via L1 `CfnUserPoolUser`

Verify zero orphans:

```bash
aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/CloudKaffeStack"
aws s3 ls | grep -i kaffe
aws cloudwatch describe-alarms --alarm-name-prefix "CloudKaffe"
aws events describe-archive --archive-name CloudKaffeArchive
aws cognito-idp list-user-pools --max-results 20 | grep -i kaffe
```

## Cost warning

⚠️ **Traffic simulator runs every minute forever until `cdk destroy`.**

Rough napkin math (1 attendee, 1 day):
- API Gateway: ~100 req/min × 60 × 8 hrs = ~48k req → ~$0.17
- DynamoDB PAY_PER_REQUEST: ~34k writes → ~$0.04
- CloudWatch Logs: ~100 MB → ~$0.05
- EventBridge archive storage (3 days): negligible
- **Total: <$1/day**

Leaving it running overnight = a few dollars. Forever = much more. Destroy at end of day.

## Next steps / out of scope

These are flagged in the design doc. Not shipped here, good candidates for follow-up:

- CI/CD (GitHub Actions: `cdk synth` on PR, `cdk deploy` on main)
- `cdk-nag` stack aspect (10 lines, catches ~40 security best-practice violations)
- Unit + snapshot tests via `aws-cdk-lib/assertions`
- Multi-stack split (auth/data/compute/sim)
- DDB Streams → Pipes outbox pattern (fixes split-brain write path between DDB and EventBridge)
- Switch OrderProcessor to `NodejsFunction` so `@aws-sdk/s3-request-presigner` bundles cleanly (currently stubbed with `s3Uri` + presign CLI hint)

## Known gaps (workshop context)

- **Split-brain write path:** OrderReceiver writes DDB then publishes EventBridge. If the PutEvents fails, order is stored but never processed. Known; not fixed in this scaffold. Production fix = DDB Streams → Pipes (see next steps above).
- **DDB Streams, TTL, OAuth scope** are spec'd but not wired to a consumer. Instructor discretion on whether to showcase during Module 5 or leave as "these are here when you need them."
