**Role:** You are an Expert AWS Serverless Architect and TypeScript CDK Developer.  
**Task:** I need a complete AWS CDK (v2) project written in TypeScript. The project is called "Cloud Kaffen" (Cloud Coffee) and serves as an advanced, production-ready serverless order management system. It will be used for an AWS Masterclass to demonstrate advanced cloud concepts. Project must be structure so any developer can clone this repo and deploy it to his own aws account, so it must be configurable for account id's, regions, etc. Use standard CDK setup and provide a clear readme with steps on how to clone, install, deploy ect. 
**Folder Structure:**  
Please use this exact structure and provide the full code for all files:  
/bin/cloud-kaffe.ts  
/lib/cloud-kaffe-stack.ts  
/lib/constructs/auth.ts  
/lib/constructs/database-and-events.ts  
/lib/constructs/api-and-compute.ts  
/lib/constructs/simulator.ts  
/src/shared-layer/utils.mjs  
/src/order-receiver/index.mjs  
/src/order-processor/index.mjs  
/src/traffic-simulator/index.mjs  
**Global Requirements:**

* Apply a global tag { Project: 'CloudKaffe' } to all resources to demonstrate Attribute-Based Access Control (ABAC) and resource grouping.  
* Use AWS CDK L2 constructs everywhere. Ensure least privilege using .grant() methods.  
* Explicitly set CloudWatch Log Group retention to 7 days for all Lambda functions.

**Detailed Resource Specifications (by module):**  
**1\. Security & Identity (auth.ts):**

* **Cognito User Pool:** Configure with Email as the sign-in alias. Enable the **Hosted UI** with a simple domain prefix.  
* **Cognito App Client:** Create without a client secret. Configure OAuth 2.0 settings with scopes (e.g., orders:write).  
* **Secrets Manager:** Create a Secret named BotUserPassword containing a dummy password. The Traffic Simulator will use this.

**2\. Data & Events (database-and-events.ts):**

* **DynamoDB Table (OrdersTable):** \> \* Partition Key: orderId (string). Billing mode: PAY\_PER\_REQUEST.  
  * Enable DynamoDB Streams (NEW\_IMAGE).  
  * Add a **Global Secondary Index (GSI)** named CoffeeTypeIndex with coffeeType as the partition key.  
  * Enable **TTL (Time To Live)** on a field named expiresAt.  
* **S3 Bucket (OrderReceiptsBucket):** Must block all public access. Configure **S3 Event Notifications** to send an event to EventBridge when a new object is created.  
* **EventBridge Custom Bus (CloudKaffeBus):** \> \* Enable **Event Archive** with a 30-day retention to demonstrate event replay.  
  * Create a Rule routing events with detail-type: "OrderCreated" to the SQS queue.  
* **SQS Queue (OrderProcessorQueue):** Set a **Visibility Timeout** of 30 seconds. Connect a **Dead-Letter Queue (DLQ)** with maxReceiveCount: 3\.  
* **SNS Topic (OrderAlertsTopic):** To be triggered by a CloudWatch Alarm if the DLQ receives messages.

**3\. Compute & API (api-and-compute.ts):**

* **Lambda Layer (SharedUtilsLayer):** Contains common functions (create a dummy utils.mjs returning a formatted date). Attach to OrderReceiver and OrderProcessor.  
* **Lambda 1 (OrderReceiver):** Node.js 20.x.  
  * Enable **AWS X-Ray** active tracing.  
  * **Code Logic (index.mjs):** Parse the incoming order. Must log custom metrics using **Embedded Metric Format (EMF)** (e.g., CoffeeSold).  
  * **Chaos Logic:** If coffeeType \=== 'FATAL\_ERROR', throw new Error("Simulated Database Crash"). If coffeeType \=== 'SLOW\_BREW', use await new Promise(r \=\> setTimeout(r, 4000)) before returning 200 OK. Save order to DynamoDB and push "OrderCreated" event to EventBridge.  
* **API Gateway (REST API):** \> \* Enable **AWS X-Ray** tracing. Deploy to a stage named v1.  
  * Add a POST /orders method protected by a **Cognito User Pool Authorizer**.  
  * Enable CORS.  
  * Implement **Request Validation (Schema Validation)** enforcing that the request body contains coffeeType and size, failing with HTTP 400 before hitting the Lambda if invalid.  
* **Lambda 2 (OrderProcessor):** Node.js 20.x. Triggered by SQS. Updates DynamoDB status to 'COMPLETED' and puts a mock receipt in the S3 Bucket.  
* **Composite Alarms:** Create a CloudWatch Composite Alarm that triggers if API Gateway 5XX Error Rate \> 5% AND total API requests \> 100 in a 1-minute period.

**4\. Traffic Simulator (simulator.ts):**

* **Lambda 3 (TrafficSimulator):** Node.js 20.x. Triggered by an EventBridge Scheduler/Rule rate(1 minute).  
* **Permissions:** Needs read access to BotUserPassword in Secrets Manager and permissions to call Cognito AdminInitiateAuth.  
* **Code Logic (index.mjs):** Fetch the secret, log in to Cognito to get a JWT access token. Run a loop 10-15 times per invocation. Inside the loop, randomly generate requests:  
  * 70%: Valid order (coffeeType: "Latte", size: "Large").  
  * 15%: Invalid schema (e.g., missing coffeeType to trigger API GW 400 error).  
  * 10%: coffeeType: "FATAL\_ERROR" (triggers 500 error).  
  * 5%: coffeeType: "SLOW\_BREW" (triggers high latency).  
    Send these as HTTP POST requests to the API Gateway endpoint using the JWT in the Authorization header.

