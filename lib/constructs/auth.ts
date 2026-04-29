import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';

export interface AuthConstructProps {
  /**
   * Per-developer namespace suffix (e.g. "alice"). Used to disambiguate
   * resources that share an account-wide / global namespace.
   */
  readonly developer: string;
  /**
   * Hosted UI domain prefix. If omitted, derived from account ID + developer
   * to avoid global Cognito namespace collisions.
   */
  readonly domainPrefix?: string;
  /**
   * Permanent password for the workshop demoUser. Documented in README.
   */
  readonly demoPassword: string;
}

export class AuthConstruct extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly botPasswordSecret: secretsmanager.Secret;
  public readonly botUsername = 'bot';
  public readonly demoUsername = 'demoUser';
  public readonly domainPrefix: string;

  constructor(scope: Construct, id: string, props: AuthConstructProps) {
    super(scope, id);

    // -----------------------------------------------------------------
    // User pool
    // -----------------------------------------------------------------
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `CloudKaffeUsers-${props.developer}`,
      signInAliases: { email: true, username: true },
      selfSignUpEnabled: false, // bot + demoUser only; no attendee sign-ups
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -----------------------------------------------------------------
    // Resource server with custom scope `orders:write`
    // (per infrastructure.md spec; not currently enforced by API GW method
    // but available on the App Client - teaching moment)
    // -----------------------------------------------------------------
    const resourceServer = this.userPool.addResourceServer('ResourceServer', {
      identifier: 'orders',
      scopes: [
        new cognito.ResourceServerScope({
          scopeName: 'write',
          scopeDescription: 'Write access to orders',
        }),
      ],
    });

    // -----------------------------------------------------------------
    // Hosted UI domain (account-derived prefix avoids global collision)
    // -----------------------------------------------------------------
    this.domainPrefix =
      props.domainPrefix ??
      `cloud-kaffe-${cdk.Stack.of(this).account}-${props.developer}`;
    this.userPool.addDomain('HostedUI', {
      cognitoDomain: { domainPrefix: this.domainPrefix },
    });

    // -----------------------------------------------------------------
    // App client (no secret; enable flows needed by simulator + Hosted UI)
    // -----------------------------------------------------------------
    this.userPoolClient = this.userPool.addClient('AppClient', {
      userPoolClientName: 'CloudKaffeApp',
      generateSecret: false,
      authFlows: {
        adminUserPassword: true, // simulator AdminInitiateAuth
        userSrp: true, // Hosted UI SRP
      },
      oAuth: {
        flows: { implicitCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.resourceServer(resourceServer, {
            scopeName: 'write',
            scopeDescription: 'Write access to orders',
          }),
        ],
        callbackUrls: ['https://example.com'], // throwaway; demo only
      },
      preventUserExistenceErrors: true,
    });

    // -----------------------------------------------------------------
    // Bot password - plaintext dummy in SecretsManager (demo only)
    // -----------------------------------------------------------------
    this.botPasswordSecret = new secretsmanager.Secret(this, 'BotPassword', {
      secretName: `CloudKaffe/${props.developer}/BotUserPassword`,
      description:
        'Cloud Kaffen bot user password (workshop demo only, rotated per deploy)',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 16,
        requireEachIncludedType: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -----------------------------------------------------------------
    // Bot user (L1 - CDK has no L2; cleanly cascade-deletes on stack destroy)
    // -----------------------------------------------------------------
    const botUser = new cognito.CfnUserPoolUser(this, 'BotUser', {
      userPoolId: this.userPool.userPoolId,
      username: this.botUsername,
      messageAction: 'SUPPRESS',
    });

    // Step 1: read the generated secret value via SDK. Must use a
    // chained custom resource because {{resolve:secretsmanager:...}} is
    // NOT resolved inside arbitrary custom-resource parameters — only
    // inside a short allowlist (RDS master password, etc). Putting it
    // directly on adminSetUserPassword.Password sets the LITERAL token
    // string as the password.
    const getBotSecret = new AwsCustomResource(this, 'GetBotSecret', {
      resourceType: 'Custom::GetBotSecret',
      onCreate: {
        service: 'SecretsManager',
        action: 'getSecretValue',
        parameters: { SecretId: this.botPasswordSecret.secretArn },
        physicalResourceId: PhysicalResourceId.of(
          `${cdk.Stack.of(this).stackName}-GetBotSecret`,
        ),
      },
      onUpdate: {
        service: 'SecretsManager',
        action: 'getSecretValue',
        parameters: { SecretId: this.botPasswordSecret.secretArn },
        physicalResourceId: PhysicalResourceId.of(
          `${cdk.Stack.of(this).stackName}-GetBotSecret`,
        ),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [this.botPasswordSecret.secretArn],
      }),
    });

    // Step 2: set the bot's password = SecretString from step 1.
    // getResponseField emits a Fn::GetAtt reference — CFN resolves it
    // to the plaintext before invoking the custom-resource Lambda.
    const setBotPassword = new AwsCustomResource(this, 'SetBotPassword', {
      resourceType: 'Custom::SetBotPassword',
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminSetUserPassword',
        parameters: {
          UserPoolId: this.userPool.userPoolId,
          Username: this.botUsername,
          Password: getBotSecret.getResponseField('SecretString'),
          Permanent: true,
        },
        physicalResourceId: PhysicalResourceId.of(
          `${cdk.Stack.of(this).stackName}-SetBotPassword`,
        ),
      },
      onUpdate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminSetUserPassword',
        parameters: {
          UserPoolId: this.userPool.userPoolId,
          Username: this.botUsername,
          Password: getBotSecret.getResponseField('SecretString'),
          Permanent: true,
        },
        physicalResourceId: PhysicalResourceId.of(
          `${cdk.Stack.of(this).stackName}-SetBotPassword`,
        ),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [this.userPool.userPoolArn],
      }),
    });
    setBotPassword.node.addDependency(botUser);
    setBotPassword.node.addDependency(getBotSecret);

    // -----------------------------------------------------------------
    // Demo user (Module 4 - attendees log in via Hosted UI)
    // -----------------------------------------------------------------
    const demoUser = new cognito.CfnUserPoolUser(this, 'DemoUser', {
      userPoolId: this.userPool.userPoolId,
      username: this.demoUsername,
      messageAction: 'SUPPRESS',
      userAttributes: [
        { name: 'email', value: 'demo@cloudkaffe.dev' },
        { name: 'email_verified', value: 'true' },
      ],
    });

    const setDemoPassword = new AwsCustomResource(this, 'SetDemoPassword', {
      resourceType: 'Custom::SetDemoPassword',
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminSetUserPassword',
        parameters: {
          UserPoolId: this.userPool.userPoolId,
          Username: this.demoUsername,
          Password: props.demoPassword,
          Permanent: true,
        },
        physicalResourceId: PhysicalResourceId.of(
          `${cdk.Stack.of(this).stackName}-SetDemoPassword`,
        ),
      },
      onUpdate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminSetUserPassword',
        parameters: {
          UserPoolId: this.userPool.userPoolId,
          Username: this.demoUsername,
          Password: props.demoPassword,
          Permanent: true,
        },
        physicalResourceId: PhysicalResourceId.of(
          `${cdk.Stack.of(this).stackName}-SetDemoPassword`,
        ),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [this.userPool.userPoolArn],
      }),
    });
    setDemoPassword.node.addDependency(demoUser);
  }
}
