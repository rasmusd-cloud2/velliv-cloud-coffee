# Cloud Kaffen — Simulated Event Flow

End-to-end walkthrough of what happens every minute when the traffic simulator fires, including all chaos branches and the observability signals each one produces.

See also: `docs/architecture.drawio` (visual) and `README.md` (deploy + workshop pointers).

---

## 1. Cadence — EventBridge schedule

**Trigger:** `AWS::Events::Rule` named `CloudKaffeTrafficSimulatorSchedule` fires on `rate(1 minute)` and invokes the `TrafficSimulator` Lambda.

- Defined in `lib/constructs/simulator.ts`
- Target: `CloudKaffeStack-TrafficSimulator`
- No input payload — the Lambda receives an empty scheduled event

This is the only wall-clock trigger in the system. Everything downstream is reactive.

---

## 2. TrafficSimulator Lambda

**Source:** `src/traffic-simulator/index.ts`

### 2a. Authenticate as `bot`

1. `GetSecretValue` on `CloudKaffe/BotUserPassword` (Secrets Manager) → plaintext password.
2. `AdminInitiateAuth` against the Cognito User Pool with flow `ADMIN_USER_PASSWORD_AUTH` for user `bot`.
3. Extract `AuthenticationResult.IdToken` — this is the JWT used as the `Authorization: Bearer` header on every order.

**Logged:** `{"event":"auth_ok","durationMs":…}` on success, `auth_fail` on error (then the invocation throws, which surfaces as a Lambda error metric).

### 2b. Build a chaos-mixed batch

Total count per invocation: `100 + floor(random()*51)` → **100–150 requests**.

For each request, pick a kind from the mix:

| Kind | Probability | Body sent to POST /orders |
|------|-------------|---------------------------|
| `valid` | 70% | `{"coffeeType":"Latte","size":"Large"}` |
| `schemaInvalid` | 10% | `{"size":"Large"}` (missing `coffeeType`) |
| `fatalError` | 10% | `{"coffeeType":"FATAL_ERROR","size":"Large"}` |dw
| `slowBrew` | 5% | `{"coffeeType":"SLOW_BREW","size":"Large"}` |
| `poisonPill` | 5% | `{"coffeeType":"POISON_PILL","size":"Large"}` |

### 2c. Fire in parallel batches of 10

`Promise.allSettled` over 10 concurrent `fetch(API_ENDPOINT + "orders", POST)` calls, looping until all 100–150 are sent.

**Logged on completion:** `{"event":"invocation_done","total":…,"counts":{…},"statuses":{…}}`. The `statuses` map is the histogram of HTTP response codes (e.g. `{"200": 102, "400": 14, "500": 11}`).

---

## 3. API Gateway — `CloudKaffeOrdersApi`

Route: `POST /v1/orders`. Three gates run in order:

### 3a. Cognito authorizer

- `CloudKaffeCognitoAuth` validates the `Authorization: Bearer <JWT>` header against the User Pool.
- Missing/invalid token → **401 Unauthorized**, request never reaches the Lambda.

### 3b. Request validator (`BodyValidator`)

- Validates body against the `Order` JSON schema: `required: [coffeeType, size]`, both `minLength: 1`.
- `schemaInvalid` bodies hit this gate — missing `coffeeType` → **400 Bad Request**, request never reaches the Lambda.
- Counts as a `4XXError` on the stage metric.

### 3c. Integration

- Passes through `LambdaIntegration(orderReceiver, { proxy: true })` — full API GW proxy event to the Lambda.
- Stage-level tracing + data trace + INFO logging enabled → every request logged to `API-Gateway-Execution-Logs_<apiId>/v1`.

---

## 4. OrderReceiver Lambda

**Source:** `src/order-receiver/index.ts`

Fast-path decisions based on `coffeeType`:

### 4a. `FATAL_ERROR`

```ts
throw new Error('Simulated Database Crash');
```

- No DDB write, no EventBridge publish.
- API GW sees 502/500 → **5XXError +1** on the stage.
- Lambda error metric +1, X-Ray segment marked error.
- The simulator's status histogram records a 500.

### 4b. `SLOW_BREW`

```ts
await new Promise((r) => setTimeout(r, 4000));
```

- 4-second sleep before continuing to the happy path below.
- Visible as a p99 spike on `OrderReceiver` Duration metric.
- Everything else succeeds — DDB write + event publish happen normally.

### 4c. Happy path (valid, POISON_PILL, SLOW_BREW after delay)

1. **Generate IDs:** `orderId = ulid()`, `now = ISO timestamp`, `expiresAt = now + 24h` (TTL).
2. **`PutItem` → DynamoDB `CloudKaffeOrders`:**
   ```
   { orderId, coffeeType, size, status: "PENDING", createdAt, expiresAt }
   ```
   - Table has a GSI on `coffeeType` (`CoffeeTypeIndex`).
   - Streams on `NEW_IMAGE` (no consumer in this stack — workshop talking point).
   - TTL attribute `expiresAt` auto-deletes rows after 24h.
3. **`PutEvents` → EventBridge `CloudKaffeBus`:**
   ```
   Source:     "cloud-kaffe.receiver"
   DetailType: "OrderCreated"
   Detail:     {"orderId","coffeeType","size","createdAt"}
   ```
4. **Emit EMF metric** to stdout:
   ```json
   { "_aws": { "Timestamp": …, "CloudWatchMetrics": [{ "Namespace":"CloudKaffe","Dimensions":[["CoffeeType"]],"Metrics":[{"Name":"CoffeeSold","Unit":"Count"}] }] },
     "CoffeeType": "Latte", "CoffeeSold": 1 }
   ```
   CloudWatch Logs parses this on ingest and materializes a metric at `CloudKaffe / CoffeeSold` with dimension `CoffeeType`.

5. **Return 200** `{ orderId, status: "PENDING" }`.

> ⚠️ Known gap: the DDB write and EventBridge publish are independent. If `PutEvents` fails after the row is written, the order stays `PENDING` forever. Production fix = DDB Streams → EventBridge Pipes outbox.

---

## 5. EventBridge — `CloudKaffeBus`

### 5a. Archive

- `CloudKaffeArchive` captures every event on the bus (pattern `{account: [<this account>]}`).
- Retention: 3 days (override via `-c archiveRetentionDays=<N>`).
- Used in Module 5 for a replay demo — because receipt keys are deterministic, replay is idempotent.

### 5b. Rule `OrderCreatedToProcessor`

- Pattern: `{ "detail-type": ["OrderCreated"] }`.
- Target: SQS queue `CloudKaffeOrderProcessor` (no input transformer — the full EventBridge envelope is delivered).
- Metric: `AWS/Events MatchedEvents` per-rule.

---

## 6. SQS — `CloudKaffeOrderProcessor`

- Visibility timeout: 30s (matches OrderProcessor Lambda timeout).
- DLQ: `CloudKaffeOrderProcessor-DLQ` with `maxReceiveCount: 3`.
- Message body: the EventBridge envelope JSON — OrderProcessor reads `JSON.parse(record.body).detail`.

Event source mapping:
```
batchSize: 1
reportBatchItemFailures: true
```

`batchSize: 1` means one SQS message → one Lambda invocation. `reportBatchItemFailures` lets the Lambda return partial-batch success so one failing record doesn't retry the whole batch (not used at batchSize=1 but idiomatic).

---

## 7. OrderProcessor Lambda

**Source:** `src/order-processor/index.ts`

For each SQS record:

### 7a. `POISON_PILL`

```ts
throw new Error(`POISON_PILL for orderId=${orderId}`);
```

- The record is added to `batchItemFailures` → SQS treats it as failed.
- SQS retries up to 3 times (receive-count-based), then moves to the DLQ.
- DLQ depth triggers `CloudKaffe-DLQ-NotEmpty` alarm → SNS `CloudKaffeOrderAlerts`.

### 7b. Happy path

1. **`UpdateItem` → DynamoDB:** flip `status` to `COMPLETED`, set `completedAt`.
2. **`PutObject` → S3 `OrderReceiptsBucket`:** key = `receipts/${orderId}.json`, body = pretty-printed receipt JSON. Key is deterministic, so replay from the EventBridge archive overwrites in place — no duplicate files.
3. **`getSignedUrl` (`@aws-sdk/s3-request-presigner`):** 1-hour presigned GET URL for the receipt. Logged so attendees can click through in CloudWatch Logs.
4. **Log** `{ "message":"Order processed", "orderId", "receiptKey", "presignedUrl" }`.

Returns `{ batchItemFailures }` — empty on success, populated on POISON_PILL.

---

## 8. Terminal state per chaos kind

| Kind | API GW | OrderReceiver | DDB row | EventBridge | SQS | OrderProcessor | S3 receipt | Where it shows up |
|------|--------|---------------|---------|-------------|-----|----------------|------------|--------------------|
| `valid` | 200 | ✅ | PENDING → COMPLETED | published | consumed | ✅ | ✅ | `CoffeeSold[Latte]` EMF, orders/min, DDB writes |
| `schemaInvalid` | 400 | — | — | — | — | — | — | API GW `4XXError`, request never hits Lambda |
| `fatalError` | 500 | throws | — | — | — | — | — | API GW `5XXError` → composite alarm, Lambda error metric |
| `slowBrew` | 200 (~4s) | ✅ | PENDING → COMPLETED | published | consumed | ✅ | ✅ | `OrderReceiver` Duration p99 spike |
| `poisonPill` | 200 | ✅ | PENDING (stays) | published | consumed 3× fail | throws | — | `CloudKaffeOrderProcessor-DLQ` depth → DLQ alarm |

> Note: `poisonPill` rows stay `PENDING` in DDB forever (there's no retry of the status update after DLQ). In a real system you'd redrive from DLQ or repair by hand — another workshop talking point.

---

## 9. Observability signals

Every signal below lands on the `CloudKaffe-Workshop` CloudWatch dashboard (`DashboardUrl` output).

**Custom metrics**
- `CloudKaffe / CoffeeSold` dimensioned by `CoffeeType` — emitted via EMF from OrderReceiver.

**AWS-managed metrics watched**
- `AWS/ApiGateway Count / 4XXError / 5XXError` on `{ApiName: CloudKaffeOrdersApi, Stage: v1}`
- `AWS/Lambda Invocations / Errors / Duration` on each of the three functions
- `AWS/SQS ApproximateNumberOfMessagesVisible` on main queue + DLQ
- `AWS/Events MatchedEvents` on `{EventBusName: CloudKaffeBus, RuleName: OrderCreatedToProcessor}`
- `AWS/DynamoDB ConsumedWriteCapacityUnits` on `CloudKaffeOrders`

**Alarms**
- `CloudKaffe-API-ErrorSpike` (composite): fires when 5XX rate > 5% **AND** request count ≥ 10 in 1 min.
  - Built from two child alarms: `CloudKaffe-API-HighErrorRate` + `CloudKaffe-API-EnoughTraffic`.
  - Triggered naturally by the 10% `FATAL_ERROR` share of simulator traffic.
- `CloudKaffe-DLQ-NotEmpty`: fires when DLQ visible messages ≥ 1.
  - Triggered by `POISON_PILL` chaos after 3 SQS retries.
  - Publishes to SNS `CloudKaffeOrderAlerts` (subscribe an email via `-c alertEmail=you@example.com`).

**Traces**
- X-Ray active tracing on both OrderReceiver + OrderProcessor. API GW propagates trace IDs, so you can follow a single order end-to-end in the X-Ray service map.

**Logs**
- `/aws/lambda/CloudKaffeStack-OrderReceiver`
- `/aws/lambda/CloudKaffeStack-OrderProcessor`
- `/aws/lambda/CloudKaffeStack-TrafficSimulator`
- `API-Gateway-Execution-Logs_<apiId>/v1`

Log Insights query the dashboard ships with:
```
fields @timestamp, @log, @message
| filter @message like /ERROR/ or level = "ERROR"
| sort @timestamp desc
| limit 50
```

---

## 10. Timing diagram

```
t=0s    EventBridge schedule fires
t=0s    TrafficSimulator invoked
t=0s    → GetSecretValue (bot password)
t=~0.2s → AdminInitiateAuth → ID token
t=~0.3s Start posting, 10-concurrent batches of ~120 requests
        │
        ├─ valid (70%)          → API GW → OrderReceiver → DDB PutItem
        │                       → EventBridge PutEvents → SQS → OrderProcessor
        │                       → DDB UpdateItem → S3 PutObject  (~2–3s total)
        │
        ├─ schemaInvalid (10%)  → API GW validator → 400  (stops here)
        │
        ├─ fatalError (10%)     → OrderReceiver throws → 500  (stops here)
        │
        ├─ slowBrew (5%)        → OrderReceiver sleeps 4s → rest of happy path
        │
        └─ poisonPill (5%)      → happy path at receiver, then OrderProcessor
                                  throws 3× → DLQ
t=~10s  invocation_done logged by simulator
t=60s   Schedule fires again
```

---

## 11. Workshop tie-ins

- **Module 1 (Observability):** watch the dashboard while the simulator runs. Every chaos kind maps to a different widget lighting up.
- **Module 2 (Compute & API):** tail OrderReceiver logs during a SLOW_BREW burst, watch p99 move on the Duration widget.
- **Module 4 (Auth):** the bot auth flow in §2a mirrors what attendees do via Hosted UI — same User Pool, same JWT shape.
- **Module 5 (Data & Events):** DDB `PENDING` vs `COMPLETED` (§4c/§7b), EventBridge archive replay (§5a), DLQ redrive (§7a).
