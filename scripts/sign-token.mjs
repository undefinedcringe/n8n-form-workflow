// Creates a short-lived HS256 token for the form webhook.
// Usage: FORM_JWT_SECRET=... node scripts/sign-token.mjs
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MIN_SECRET_LENGTH = 32;
const DEFAULT_LIFETIME_SECONDS = 60;

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function signToken(secret, lifetimeSeconds = DEFAULT_LIFETIME_SECONDS, nowMs = Date.now()) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`FORM_JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  const iat = Math.floor(nowMs / 1000);
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iat, exp: iat + lifetimeSeconds })}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(signToken(process.env.FORM_JWT_SECRET));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
