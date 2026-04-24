Det er en fantastisk plan\! At have en struktureret drejebog og en præcis byggevejledning gør, at du kan fokusere på at formidle og facilitere frem for at bekymre dig om teknikken på dagen.  
Her får du hele pakken: En komplet agenda, en dybdegående tjekliste til dine gennemgange, og en "AI-prompt", du direkte kan fodre et system med for at få genereret din CDK-kode.

## ---

**1\. 📅 Den fulde tidsplan: AWS Masterclass ("Cloud Kaffen")**

Her er den endelige agenda, hvor vi bygger "Cloud Kaffen" lag for lag.

| Tidspunkt | Modul | Fokus i koden & konsollen |
| :---- | :---- | :---- |
| **09:00 – 09:15** | **Velkomst & Arkitektur** | Gennemgang af dagens use-case ("Cloud Kaffen"). Tegn arkitekturen på et whiteboard. |
| **09:15 – 10:15** | **1\. Observability (CloudWatch)** | Skyd trafik (Chaos script) mod et pre-deployed API. Dyk ned i Logs, Insights, Metrics og Alarmer i konsollen. |
| **10:15 – 10:30** | **Pause** | (15 minutter) |
| **10:30 – 11:45** | **2\. Compute & API (Lambda \+ API GW)** | Gennemgå koden for OrderReceiver-Lambdaen og API Gateway. Vis lifecycle, memory, og stages i konsollen. |
| **11:45 – 12:25** | **Frokost** | (40 minutter) |
| **12:25 – 13:40** | **3\. Infrastructure as Code (CDK & CFN)** | Kig på selve CDK-projektstrukturen. Kør cdk synth og vis den genererede CloudFormation. Kør cdk diff og deploy. |
| **13:40 – 13:55** | **Pause** | (15 minutter) |
| **13:55 – 14:35** | **4\. Sikkerhed & Auth (Cognito)** | Tilføj Cognito. Vis User Pools, og test API'et med/uden et JWT-token (Postman/Curl). |
| **14:35 – 14:45** | **Kort Pause** | (10 minutter) |
| **14:45 – 15:45** | **5\. Data & Events (Event-drevet arkitektur)** | Udrul resten af CDK-koden (DynamoDB, EventBridge, SQS, SNS, S3). Følg en bestilling hele vejen igennem systemet visuelt. |
| **15:45 – 16:00** | **Opsamling & Q\&A** | Kør cdk destroy for at vise oprydning, og svar på de sidste spørgsmål. |

## ---

**2\. 🔍 Detaljeret gennemgang af services (Hvad du præcist skal vise)**

For at deltagerne føler sig trygge, skal du fjerne magien og vise, hvor knapperne sidder. Her er dine "talking points" for hver service:

### **CloudWatch (Observability)**

* **Logs & Log Groups:** Vis hvordan hver Lambda får sin egen Log Group (/aws/lambda/...). Vis **Retention**\-indstillingen og forklar, at "Never expire" koster dyrt i længden.  
* **Logs Insights:** Kør en live-søgning\! Vis denne query for at finde fejl: fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc.  
* **Metrics:** Vis "Lambda Duration" og "API Gateway 5XX Errors". Forklar *Namespaces* (hvilken service) og *Dimensions* (specifik ressource).

### **Lambda & API Gateway (Compute)**

* **Lambda Lifecycle:** Forklar forskellen på "Init" (Cold Start) og "Invoke" (Warm Start). Vis det i CloudWatch loggen, hvor Init Duration fremgår.  
* **Memory vs. CPU:** Forklar reglen: Du kan ikke skrue direkte på CPU. Du skruer på Memory, og AWS tildeler proportionelt mere vCPU og netværk.  
* **API Gateway Stages:** Vis i konsollen, at et API har "Stages" (f.eks. dev, prod). Forklar at man skal *deploye* for at ændringer træder i kraft.  
* **CORS:** Nævn det kort som den klassiske "browser-dræber", når frontend og backend er på forskellige domæner.

### **CDK & CloudFormation (IaC)**

* **L2 Constructs:** Vis koden. Forklar at CDK's L2 constructs har "sunde defaults" (f.eks. sætter de selv kryptering og IAM-roller op).  
* **Least Privilege:** Vis hvordan table.grantReadWriteData(myLambda) automatisk genererer de korrekte IAM-policies. Det er CDK's største styrke.  
* **CloudFormation Template:** Åbn CloudFormation-konsollen. Vis fanerne "Events" (hvordan stakken bygges) og "Resources" (hvad der blev skabt). Forklar rollback-mekanismen, hvis noget fejler.

### **Cognito (Auth)**

* **User Pools:** Gør det klart: User Pools er til *autentifikation* (hvem er du?).  
* **JWT Tokens:** Generer et token og sæt det ind i jwt.io på storskærm. Vis payloaden, så de forstår, at et token blot er base64-kodet JSON.

### **Data & Events (Asynkron arkitektur)**

* **DynamoDB:** Vis tabellen i konsollen. Forklar forskellen på *Query* (målrettet opslag på Partition Key \- billigt) og *Scan* (læs hele tabellen \- dyrt og langsomt).  
* **SQS (DLQ):** Vis at køen har en "Visibility Timeout" (den tid beskeden er skjult for andre workers, mens en Lambda behandler den). Vis Dead-Letter Queue: "Hvad sker der, hvis kaffemaskinen er i stykker 3 gange i træk?".  
* **SNS:** Forklar *Fan-out*: Én besked ind i SNS, der sendes ud til flere lyttere (f.eks. en e-mail til dig og en SQS-kø).  
* **EventBridge:** Forklar det som "virksomhedens centrale posthus". Vis en regel, der fanger præcis OrderCreated events.  
* **S3 Presigned URLs:** Forklar konceptet: En tidsbegrænset, sikker adgangsbillet til en privat fil, udstedt af backend'en.

## ---

**3\. 🤖 Prompt til AI-kodegenerering**

Du kan kopiere nedenstående tekst direkte ind i en AI-assistent (f.eks. ChatGPT eller Claude) for at få den til at bygge projektet for dig.  
***Kopier herfra:***  
**Rolle:** Du er en Expert AWS Cloud Architect og TypeScript Developer.  
**Opgave:** Jeg skal bruge et komplet AWS CDK (v2) projekt skrevet i TypeScript. Projektet hedder "Cloud Kaffen" og er et serverless bestillingssystem.  
**Mappestruktur:**  
Venligst brug denne struktur:  
/bin/cloud-kaffe.ts  
/lib/cloud-kaffe-stack.ts  
/lib/constructs/api-compute.ts  
/lib/constructs/database.ts  
/lib/constructs/auth.ts  
/src/order-receiver/index.mjs  
/src/order-processor/index.mjs  
**Ressourcer der skal oprettes via CDK L2 constructs:**  
**1\. Database & Messaging (database.ts):**

* DynamoDB Table (OrdersTable): Partition key orderId (string). Billing mode: PAY\_PER\_REQUEST. Enable DynamoDB Streams (NEW\_IMAGE).  
* EventBridge EventBus (CloudKaffeBus).  
* SQS Queue (OrderProcessorQueue) med en forbundet Dead-Letter Queue (DLQ).  
* SNS Topic (OrderAlertsTopic) som modtager beskeder fra DLQ'en (via CloudWatch Alarm eller lignende mekanisme).  
* S3 Bucket (OrderReceiptsBucket): Skal være privat med block public access.

**2\. Sikkerhed (auth.ts):**

* Cognito User Pool med email som sign-in alias.  
* Cognito User Pool Client (App Client) uden client secret, sat op til User Password Auth.

**3\. Compute & API (api-compute.ts):**

* **Lambda 1 (OrderReceiver):** Node.js 20.x, integreret med API Gateway. Skal have skriveadgang til DynamoDB og eventuelt sende event til EventBridge.  
* **API Gateway (REST API):** Skal have en ressource /orders med en POST metode. Denne POST-metode skal sikres med en Cognito User Pool Authorizer (bundet til User Pool fra auth.ts) og trigger OrderReceiver Lambdaen. Skal have CORS konfigureret for alle origins.  
* **Lambda 2 (OrderProcessor):** Node.js 20.x. Triggeres af OrderProcessorQueue (SQS Event Source). Skal have skriveadgang til DynamoDB og adgang til at lægge filer (kvitteringer) i S3 Bucketen.

**4\. Integrationer & Permissions:**

* CDK koden skal binde det hele sammen i cloud-kaffe-stack.ts ved at instantiere constructs og videregive ressourcer.  
* Brug .grant() metoder for least privilege.  
* Sæt en fast Log Retention på alle Lambda Log Groups til 1 uge.

**Output:**  
Giv mig den fulde kode for hver fil (TS-filer og korte, mock-implementeringer af MJS Lambda-filerne). For Lambdaerne er det nok, at de logger modtagne events, returnerer et succes-svar, og i Processor-lambdaen opdaterer DynamoDB og danner en mock presigned S3 URL.