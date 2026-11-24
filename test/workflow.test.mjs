import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { signToken } from '../scripts/sign-token.mjs';

const load = (file) =>
  JSON.parse(readFileSync(new URL(`../workflows/${file}`, import.meta.url), 'utf8'));

const form = load('form-submission.json');
const errorAlert = load('error-alert.json');
const allWorkflows = [form, errorAlert];
const byName = (name) => form.nodes.find((n) => n.name === name);
// One fixed clock for token expiry and validation, so a second ticking over cannot flip a boundary test.
const NOW_MS = Date.now();
const nowSeconds = () => Math.floor(NOW_MS / 1000);

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const TOKEN = { exp: nowSeconds() + 60 };

// Runs the exact code embedded in the workflow, with n8n's globals stubbed.
const run = (body, options = {}) => {
  const { headers = JSON_HEADERS, binary } = options;
  const jwtPayload = 'jwtPayload' in options ? options.jwtPayload : TOKEN;
  const item = { json: { body, headers, jwtPayload }, binary };
  const execute = new Function('$', byName('Validate Submission').parameters.jsCode);
  const realNow = Date.now;
  Date.now = () => NOW_MS;
  try {
    return execute((name) => {
      assert.equal(name, 'Form Webhook');
      return { first: () => item };
    })[0].json;
  } finally {
    Date.now = realNow;
  }
};

const good = { name: 'Ada Lovelace', email: 'Ada@Example.com', message: 'Hello' };
const invisible = (code) => String.fromCodePoint(code);

test('accepts a valid submission and normalizes it', () => {
  const r = run(good);
  assert.equal(r.valid, true);
  assert.equal(r.submission.email, 'ada@example.com');
});

test('accepts URL-encoded forms', () => {
  assert.equal(run(good, { headers: { 'content-type': 'application/x-www-form-urlencoded' } }).valid, true);
});

test('drops fields that are not allowlisted', () => {
  const r = run({ ...good, isAdmin: true });
  assert.deepEqual(Object.keys(r.submission).sort(), ['email', 'message', 'name', 'submitted_at']);
});

for (const [label, jwtPayload] of [
  ['missing', undefined],
  ['no expiry', { sub: 'x' }],
  ['non-integer expiry', { exp: 'soon' }],
  ['expired', { exp: nowSeconds() - 1 }],
  ['too long-lived', { exp: nowSeconds() + 301 }],
]) {
  test(`rejects token: ${label}`, () => {
    assert.equal(run(good, { jwtPayload }).statusCode, 401);
  });
}

for (const headers of [{}, { 'content-type': 'text/plain' }, { 'content-type': 'multipart/form-data; boundary=x' }]) {
  test(`rejects content type: ${JSON.stringify(headers)}`, () => {
    assert.equal(run(good, { headers }).statusCode, 415);
  });
}

test('rejects file uploads', () => {
  assert.equal(run(good, { binary: { file: { data: 'x' } } }).statusCode, 415);
});

for (const body of [null, [], 'text', 5, undefined]) {
  test(`rejects non-object body: ${JSON.stringify(body)}`, () => {
    assert.equal(run(body).statusCode, 400);
  });
}

test('reports each missing field', () => {
  const r = run({});
  assert.equal(r.statusCode, 422);
  assert.deepEqual(Object.keys(r.response.errors).sort(), ['email', 'message', 'name']);
});

test('rejects non-string values', () => {
  assert.equal(run({ name: { a: 1 }, email: ['a@b.co'], message: 7 }).statusCode, 422);
});

for (const email of [
  'nope', 'a@b', 'a b@c.co', 'a@b.co,x@y.co', 'a@b.co\nBcc:x@y.co', 'a@b..co', '.a@b.co', 'a.@b.co',
  'a@-b.co', 'a@b-.co', 'a@.b.co', 'a\\b@c.co', 'a@b.co.',
]) {
  test(`rejects bad email: ${JSON.stringify(email)}`, () => {
    assert.equal(run({ ...good, email }).statusCode, 422);
  });
}

for (const email of ['first.last+tag@sub.example.co', "o'neil@example.com", 'a@xn--bcher-kva.example']) {
  test(`accepts email: ${email}`, () => {
    assert.equal(run({ ...good, email }).valid, true);
  });
}

test('enforces length limits', () => {
  assert.ok(run({ ...good, name: 'x'.repeat(101) }).response.errors.name);
  assert.ok(run({ ...good, message: 'x'.repeat(5001) }).response.errors.message);
  assert.equal(run({ ...good, message: 'x'.repeat(5000) }).valid, true);
});

test('rejects huge values quickly', () => {
  const huge = '\t x'.repeat(5e6);
  const started = performance.now();
  assert.equal(run({ ...good, name: huge, message: huge }).statusCode, 422);
  assert.ok(performance.now() - started < 200);
});

test('strips line breaks from single-line fields', () => {
  assert.equal(run({ ...good, name: 'Ada\r\nBcc: x@y.co' }).submission.name, 'Ada Bcc: x@y.co');
});

test('keeps line breaks in the message', () => {
  assert.equal(run({ ...good, message: 'a\r\nb\u0007' }).submission.message, 'a\nb');
});

test('removes Unicode line and paragraph separators', () => {
  const r = run({ ...good, name: `Ada${invisible(0x2028)}Bcc`, message: `a${invisible(0x2029)}b` });
  assert.equal(r.submission.name, 'Ada Bcc');
  assert.equal(r.submission.message, 'ab');
});

for (const code of [0x202e, 0x2066, 0x200b, 0xfeff, 0x85]) {
  test(`removes hidden character U+${code.toString(16)}`, () => {
    const r = run({ ...good, name: `Ada${invisible(code)}B`, message: `a${invisible(code)}b` });
    assert.ok(!r.submission.name.includes(invisible(code)));
    assert.equal(r.submission.message, 'ab');
  });
}

test('keeps joiners used by emoji and written languages', () => {
  const family = `\u{1F468}${invisible(0x200d)}\u{1F469}`;
  assert.equal(run({ ...good, message: family }).submission.message, family);
});

for (const code of [0x200b, 0x200d, 0xfeff]) {
  test(`treats invisible-only input U+${code.toString(16)} as empty`, () => {
    const r = run({ ...good, name: invisible(code), message: invisible(code) });
    assert.ok(r.response.errors.name && r.response.errors.message);
  });
}

for (const payload of ['=IMPORTXML("http://x","//a")', '+1+1', '-1', '@SUM(A1)']) {
  test(`neutralizes spreadsheet formula: ${payload}`, () => {
    const r = run({ ...good, name: payload, message: payload });
    assert.equal(r.sheet.name, `'${payload}`);
    assert.equal(r.sheet.message, `'${payload}`);
    assert.equal(r.submission.message, payload);
  });
}

test('neutralizes a formula hidden behind a zero-width character', () => {
  const r = run({ ...good, message: `${invisible(0x200b)}=1+1` });
  assert.equal(r.sheet.message, "'=1+1");
});

for (const website of ['http://spam.example', ['x'], { a: 1 }, 1, true, 0, false]) {
  test(`honeypot catches ${JSON.stringify(website)}`, () => {
    const r = run({ ...good, website });
    assert.equal(r.statusCode, 202);
    assert.equal(r.response.ok, true);
    assert.equal(r.submission, undefined);
  });
}

for (const website of ['', '   ', null, undefined]) {
  test(`honeypot ignores empty value ${JSON.stringify(website)}`, () => {
    assert.equal(run({ ...good, website }).valid, true);
  });
}

test('identical content in one window has one dedupe source', () => {
  assert.equal(run(good).dedupe_source, run({ ...good }).dedupe_source);
  assert.notEqual(run(good).dedupe_source, run({ ...good, message: 'Different' }).dedupe_source);
});

test('an idempotency key controls the dedupe source', () => {
  const key = 'abcDEF123456_-xyz';
  assert.equal(
    run({ ...good, idempotency_key: key }).dedupe_source,
    run({ ...good, message: 'Edited', idempotency_key: key }).dedupe_source,
  );
});

for (const key of ['short', 'x'.repeat(65), 'has space in it!!', 12345, ['abcDEF123456_-xyz']]) {
  test(`rejects idempotency key: ${JSON.stringify(key)}`, () => {
    assert.ok(run({ ...good, idempotency_key: key }).response.errors.idempotency_key);
  });
}

test('error responses never echo input', () => {
  const canary = 'ECHO_CANARY';
  const r = run({ name: canary, email: canary, message: 'x'.repeat(5001) + canary });
  assert.ok(!JSON.stringify(r).includes(canary));
});

test('signToken creates a short-lived token and refuses weak secrets', () => {
  const [, payload] = signToken('k'.repeat(32), 60, 1000000).split('.');
  const { iat, exp } = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(exp - iat, 60);
  assert.throws(() => signToken('short'));
});

test('every connection points at a real node', () => {
  for (const wf of allWorkflows) {
    const names = new Set(wf.nodes.map((n) => n.name));
    assert.equal(names.size, wf.nodes.length);
    for (const [source, { main }] of Object.entries(wf.connections)) {
      assert.ok(names.has(source), source);
      for (const output of main) for (const t of output) assert.ok(names.has(t.node), t.node);
    }
  }
});

test('every path sends exactly one HTTP response', () => {
  const isResponse = (name) => byName(name).type === 'n8n-nodes-base.respondToWebhook';
  const walk = (name, seen, responses) => {
    assert.ok(!seen.includes(name), `cycle at ${name}`);
    const count = responses + (isResponse(name) ? 1 : 0);
    const targets = (form.connections[name]?.main ?? []).flat();
    if (targets.length === 0) assert.equal(count, 1, `${[...seen, name].join(' > ')}`);
    for (const t of targets) walk(t.node, [...seen, name], count);
  };
  walk('Form Webhook', [], 0);
});

test('nodes with an error output have that output wired', () => {
  for (const n of form.nodes.filter((x) => x.onError === 'continueErrorOutput')) {
    assert.equal(form.connections[n.name].main.length, 2, n.name);
    assert.ok(form.connections[n.name].main[1].length > 0, n.name);
  }
});

test('every failure path ends by failing the run', () => {
  for (const [source, flag] of [
    ['Respond Unavailable', 'Flag Save Failure'],
    ['Respond Internal Error', 'Flag Validation Failure'],
  ]) {
    assert.equal(form.connections[source].main[0][0].node, flag);
    assert.equal(byName(flag).type, 'n8n-nodes-base.stopAndError');
  }
  assert.equal(form.connections['Send Notification'].main[1][0].node, 'Flag Email Failure');
});

test('the sender gets a reply before email runs', () => {
  assert.equal(form.connections['Save to Sheet'].main[0][0].node, 'Respond Success');
  assert.equal(form.connections['Respond Success'].main[0][0].node, 'Send Notification');
});

test('the run outlives every stalled email attempt', () => {
  const stalledAttemptSeconds = 600;
  const { maxTries, waitBetweenTries } = byName('Send Notification');
  const worstCase = maxTries * stalledAttemptSeconds + ((maxTries - 1) * waitBetweenTries) / 1000;
  assert.ok(form.settings.executionTimeout > worstCase);
});

test('external calls retry with bounded timeouts', () => {
  for (const wf of allWorkflows) {
    for (const n of wf.nodes.filter((x) => /httpRequest|emailSend/.test(x.type))) {
      assert.equal(n.retryOnFail, true, n.name);
      assert.ok(n.maxTries >= 2, n.name);
      if (n.type.endsWith('httpRequest')) assert.equal(n.parameters.options.timeout, 15000, n.name);
    }
  }
});

test('webhook requires a signed token', () => {
  assert.equal(byName('Form Webhook').parameters.authentication, 'jwtAuth');
});

test('sheet writes use the atomic raw append endpoint', () => {
  for (const name of ['Save to Sheet']) {
    const n = byName(name);
    assert.match(n.parameters.url, /:append$/);
    const query = Object.fromEntries(n.parameters.queryParameters.parameters.map((p) => [p.name, p.value]));
    assert.deepEqual(query, { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
  }
});

test('the duplicate check reads only the ID column', () => {
  assert.match(byName('Check Existing').parameters.url, /Submissions!A:A$/);
});

test('emails are plain text', () => {
  for (const n of allWorkflows.flatMap((wf) => wf.nodes).filter((x) => x.type.endsWith('emailSend'))) {
    assert.equal(n.parameters.emailFormat, 'text');
  }
});

test('the error alert contains no submitted data or error text', () => {
  const text = JSON.stringify(errorAlert.nodes.map((n) => n.parameters));
  assert.ok(!/submission\.|\.body|execution\.error/.test(text));
});

test('exports contain no credentials or real addresses', () => {
  for (const wf of allWorkflows) {
    assert.ok(wf.nodes.every((n) => !n.credentials), wf.name);
    const withoutCode = JSON.stringify({
      ...wf,
      nodes: wf.nodes.map((n) => ({ ...n, parameters: { ...n.parameters, jsCode: undefined } })),
    });
    assert.ok(!/[\w.+-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(withoutCode), wf.name);
  }
});

test('the form workflow points at the error workflow', () => {
  assert.equal(form.settings.errorWorkflow, errorAlert.id);
});

test('successful runs are discarded and failed runs are kept', () => {
  assert.equal(form.settings.saveDataSuccessExecution, 'none');
  assert.equal(form.settings.saveDataErrorExecution, 'all');
});
