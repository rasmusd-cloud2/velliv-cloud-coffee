/**
 * Traffic Simulator Lambda (TypeScript, bundled by NodejsFunction/esbuild).
 *
 * Every 1 minute: auth as bot -> build 100-150 request descriptors with
 * chaos mix -> POST in parallelized batches of 10 via Promise.allSettled.
 *
 * Mix: 70% valid / 10% schemaInvalid / 10% FATAL_ERROR / 5% SLOW_BREW / 5% POISON_PILL
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const secrets = new SecretsManagerClient({});
const cognito = new CognitoIdentityProviderClient({});

const API_ENDPOINT = process.env.API_ENDPOINT!;
const USER_POOL_ID = process.env.USER_POOL_ID!;
const CLIENT_ID = process.env.CLIENT_ID!;
const BOT_SECRET_ARN = process.env.BOT_SECRET_ARN!;
const BOT_USERNAME = process.env.BOT_USERNAME ?? 'bot';

type Kind =
  | 'valid'
  | 'schemaInvalid'
  | 'fatalError'
  | 'slowBrew'
  | 'poisonPill';

interface MixEntry {
  key: Kind;
  pct: number;
}

const MIX: readonly MixEntry[] = [
  { key: 'valid', pct: 70 },
  { key: 'schemaInvalid', pct: 10 },
  { key: 'fatalError', pct: 10 },
  { key: 'slowBrew', pct: 5 },
  { key: 'poisonPill', pct: 5 },
];

interface OrderBody {
  coffeeType?: string;
  size: string;
}

function pickKind(): Kind {
  const r = Math.random() * 100;
  let acc = 0;
  for (const m of MIX) {
    acc += m.pct;
    if (r < acc) return m.key;
  }
  return 'valid';
}

function buildBody(kind: Kind): OrderBody {
  switch (kind) {
    case 'valid':
      return { coffeeType: 'Latte', size: 'Large' };
    case 'schemaInvalid':
      return { size: 'Large' };
    case 'fatalError':
      return { coffeeType: 'FATAL_ERROR', size: 'Large' };
    case 'slowBrew':
      return { coffeeType: 'SLOW_BREW', size: 'Large' };
    case 'poisonPill':
      return { coffeeType: 'POISON_PILL', size: 'Large' };
  }
}

async function getBotPassword(): Promise<string> {
  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: BOT_SECRET_ARN }),
  );
  if (!res.SecretString) {
    throw new Error('Bot secret has no SecretString');
  }
  return res.SecretString;
}

async function getIdToken(password: string): Promise<string> {
  const res = await cognito.send(
    new AdminInitiateAuthCommand({
      UserPoolId: USER_POOL_ID,
      ClientId: CLIENT_ID,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: BOT_USERNAME, PASSWORD: password },
    }),
  );
  const token = res.AuthenticationResult?.IdToken;
  if (!token) {
    throw new Error('Cognito AdminInitiateAuth returned no IdToken');
  }
  return token;
}

async function postOrder(
  token: string,
  body: OrderBody,
): Promise<{ status: number; kind: string }> {
  const res = await fetch(`${API_ENDPOINT}orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, kind: body.coffeeType ?? 'missing' };
}

export const handler = async (): Promise<{
  total: number;
  counts: Record<string, number>;
}> => {
  const authStart = Date.now();
  let token: string;
  try {
    const pw = await getBotPassword();
    token = await getIdToken(pw);
    console.log(
      JSON.stringify({
        event: 'auth_ok',
        durationMs: Date.now() - authStart,
      }),
    );
  } catch (err) {
    const error = err as Error;
    console.error(
      JSON.stringify({ event: 'auth_fail', error: error.message }),
    );
    throw err;
  }

  const total = 100 + Math.floor(Math.random() * 51);
  const descriptors = Array.from({ length: total }, () =>
    buildBody(pickKind()),
  );

  const counts = {
    valid: 0,
    schemaInvalid: 0,
    fatalError: 0,
    slowBrew: 0,
    poisonPill: 0,
  };
  const statuses = new Map<number, number>();

  const BATCH = 10;
  for (let i = 0; i < descriptors.length; i += BATCH) {
    const batch = descriptors.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map((b) => postOrder(token, b)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        statuses.set(r.value.status, (statuses.get(r.value.status) ?? 0) + 1);
      }
    }
    for (const b of batch) {
      const kind = b.coffeeType ?? 'schemaInvalid';
      if (kind === 'FATAL_ERROR') counts.fatalError++;
      else if (kind === 'SLOW_BREW') counts.slowBrew++;
      else if (kind === 'POISON_PILL') counts.poisonPill++;
      else if (kind === 'Latte') counts.valid++;
      else counts.schemaInvalid++;
    }
  }

  console.log(
    JSON.stringify({
      event: 'invocation_done',
      total,
      counts,
      statuses: Object.fromEntries(statuses),
    }),
  );
  return { total, counts };
};
