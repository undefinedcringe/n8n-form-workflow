// Runs inside an n8n Code node. Embedded into the workflow by scripts/build.mjs.
// Only allowlisted fields leave this node. Unknown input is dropped.

const LIMITS = { name: 100, email: 254, message: 5000 };
const MAX_TOKEN_LIFETIME_SECONDS = 300;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const ALLOWED_CONTENT_TYPES = new Set(['application/json', 'application/x-www-form-urlencoded']);
const HONEYPOT_FIELD = 'website';
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const EMAIL_PATTERN =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Format characters include text-reversing and zero-width marks.
// Joiners stay because emoji and several written languages need them.
const HIDDEN_FORMAT = /(?![‌‍])\p{Cf}/gu;
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

const asText = (value) => (typeof value === 'string' ? value.normalize('NFC') : '');

// Single-line fields lose all control characters, which blocks email header injection.
const cleanLine = (value) =>
  asText(value)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(HIDDEN_FORMAT, '')
    .replace(/\s+/g, ' ')
    .trim();

const cleanMultiline = (value) =>
  asText(value)
    .replace(/\r\n?/g, '\n')
    .replace(/(?![\n\t])\p{Cc}|[\p{Zl}\p{Zp}]/gu, '')
    .replace(HIDDEN_FORMAT, '')
    .trim();

// Stops spreadsheet apps from running user input as a formula, including after CSV export.
const guardCell = (value) => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

// Rejects huge values before any expensive text processing runs.
const isOversized = (value, limit) => typeof value === 'string' && value.length > limit * 2;

const isHoneypotFilled = (value) =>
  typeof value === 'string' ? cleanLine(value.slice(0, 100)) !== '' : value !== undefined && value !== null;

const reject = (statusCode, message, errors) => ({
  valid: false,
  statusCode,
  response: { ok: false, message, ...(errors ? { errors } : {}) },
});

// n8n verifies the signature and expiry, but accepts tokens that never expire.
const hasShortLivedToken = (payload, nowMs) => {
  if (!Number.isInteger(payload?.exp)) return false;
  const remaining = payload.exp - Math.floor(nowMs / 1000);
  return remaining > 0 && remaining <= MAX_TOKEN_LIFETIME_SECONDS;
};

const contentTypeOf = (headers) =>
  String(headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();

function validateFields(body) {
  const errors = {};
  for (const field of Object.keys(LIMITS)) {
    if (isOversized(body[field], LIMITS[field])) {
      errors[field] = `${field} must be ${LIMITS[field]} characters or fewer.`;
    }
  }
  if (Object.keys(errors).length > 0) return { errors };

  const name = cleanLine(body.name);
  const email = cleanLine(body.email).toLowerCase();
  const message = cleanMultiline(body.message);

  if (!VISIBLE.test(name)) errors.name = 'Name is required.';
  else if (name.length > LIMITS.name) errors.name = `name must be ${LIMITS.name} characters or fewer.`;

  if (!email) errors.email = 'Email is required.';
  else if (email.length > LIMITS.email || !EMAIL_PATTERN.test(email)) errors.email = 'Email is not valid.';

  if (!VISIBLE.test(message)) errors.message = 'Message is required.';
  else if (message.length > LIMITS.message) errors.message = `message must be ${LIMITS.message} characters or fewer.`;

  const key = body.idempotency_key;
  if (key !== undefined && (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key))) {
    errors.idempotency_key = 'idempotency_key must be 16 to 64 letters, digits, hyphens, or underscores.';
  }

  return { errors, fields: { name, email, message } };
}

function validate(webhook, nowMs) {
  const { body, headers, jwtPayload } = webhook.json;

  if (!hasShortLivedToken(jwtPayload, nowMs)) {
    return reject(401, 'Authorization token must expire within 5 minutes.');
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentTypeOf(headers)) || Object.keys(webhook.binary ?? {}).length > 0) {
    return reject(415, 'Send the form as JSON or URL-encoded data without files.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return reject(400, 'Request body must be a form or JSON object.');
  }

  // Bots get the normal success reply and nothing is stored.
  if (isHoneypotFilled(body[HONEYPOT_FIELD])) {
    return {
      valid: false,
      statusCode: 202,
      response: { ok: true, message: 'Thanks, your submission was received.' },
    };
  }

  const { errors, fields } = validateFields(body);
  if (Object.keys(errors).length > 0) {
    return reject(422, 'Please correct the highlighted fields.', errors);
  }

  const { name, email, message } = fields;
  const submittedAt = new Date(nowMs).toISOString();
  const window = Math.floor(nowMs / DEDUPE_WINDOW_MS);

  return {
    valid: true,
    statusCode: 200,
    // Hashed by the next node into a submission ID that survives n8n database resets.
    dedupe_source: body.idempotency_key
      ? JSON.stringify(['key', body.idempotency_key])
      : JSON.stringify(['content', window, name, email, message]),
    submission: { submitted_at: submittedAt, name, email, message },
    sheet: {
      submitted_at: submittedAt,
      name: guardCell(name),
      email: guardCell(email),
      message: guardCell(message),
    },
  };
}

return [{ json: validate($('Form Webhook').first(), Date.now()) }];
