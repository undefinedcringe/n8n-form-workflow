// Generates the importable n8n workflow files in workflows/.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const validationCode = readFileSync(join(root, 'src/validate-submission.js'), 'utf8');

const FORM_WORKFLOW_ID = 'formSubmission01';
const ERROR_WORKFLOW_ID = 'formErrorAlert01';
// The mail library gives up on a stalled server after 10 minutes, and n8n cannot interrupt it sooner.
// The run must outlive both attempts, because a run cancelled by timeout never starts the error workflow.
const EMAIL_MAX_TRIES = 2;
const FORM_TIMEOUT_SECONDS = 1500;
const CONFIG = "$('Config').first().json";
const VALIDATED = "$('Validate Submission').first().json";
const SUBMISSION_ID = "('sub-' + $('Create Submission ID').first().json.hash.slice(0, 32))";
const FAILURE = "$('On Workflow Error').first().json";
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 };
const SHEETS_TIMEOUT_MS = 15000;

const stableId = (seed) => {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
  id: stableId(name),
  name,
  type: `n8n-nodes-base.${type}`,
  typeVersion,
  position,
  parameters,
  ...extra,
});

const main = (...outputs) => outputs.map((targets) =>
  targets.map((target) => ({ node: target, type: 'main', index: 0 })));

const configNode = (position, assignments) =>
  node('Config', 'set', 3.4, position, {
    mode: 'manual',
    includeOtherFields: false,
    assignments: {
      assignments: assignments.map(([name, value]) => ({
        id: stableId(`config-${name}`), name, value, type: 'string',
      })),
    },
    options: {},
  });

const sheetsUrl = (range) =>
  `=https://sheets.googleapis.com/v4/spreadsheets/{{ encodeURIComponent(${CONFIG}.spreadsheetId) }}/values/${range}`;

const sheetsRequest = (name, position, method, url, query, body, extra) =>
  node(name, 'httpRequest', 4.2, position, {
    method,
    url,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'googleSheetsOAuth2Api',
    sendQuery: true,
    queryParameters: { parameters: Object.entries(query).map(([key, value]) => ({ name: key, value })) },
    ...(body ? { sendBody: true, specifyBody: 'json', jsonBody: body } : {}),
    options: { timeout: SHEETS_TIMEOUT_MS },
  }, { ...RETRY, ...extra });

// Google's append endpoint is atomic, so concurrent submissions cannot overwrite each other.
const sheetsAppend = (name, position, range, row, extra) =>
  sheetsRequest(name, position, 'POST', sheetsUrl(`${range}:append`),
    { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
    `={{ JSON.stringify({ values: [[${row.join(', ')}]] }) }}`, extra);

const emailNode = (name, position, subject, text, extra) =>
  node(name, 'emailSend', 2.1, position, {
    fromEmail: `={{ ${CONFIG}.fromEmail }}`,
    toEmail: `={{ ${CONFIG}.notifyEmail }}`,
    subject,
    emailFormat: 'text',
    text,
    options: { appendAttribution: false },
  }, { ...RETRY, ...extra });

const respond = (name, position, responseCode, responseBody) =>
  node(name, 'respondToWebhook', 1.1, position, {
    respondWith: 'json',
    responseBody,
    options: { responseCode },
  });

// Marks the run as failed after replying, so n8n keeps it and starts the error workflow.
const flagFailure = (name, position, errorMessage) =>
  node(name, 'stopAndError', 1, position, { errorType: 'errorMessage', errorMessage });

const successBody =
  `={{ { ok: true, message: 'Thanks, your submission was received.', id: ${SUBMISSION_ID} } }}`;

const notificationText = [
  '=A new form submission was saved.',
  '',
  `Submission: {{ ${SUBMISSION_ID} }}`,
  `Received: {{ ${VALIDATED}.submission.submitted_at }}`,
  `Name: {{ ${VALIDATED}.submission.name }}`,
  `Email: {{ ${VALIDATED}.submission.email }}`,
  '',
  'Message:',
  `{{ ${VALIDATED}.submission.message }}`,
].join('\n');

const formWorkflow = {
  id: FORM_WORKFLOW_ID,
  name: 'Form Submission to Sheets and Email',
  nodes: [
    node('Form Webhook', 'webhook', 2, [0, 300], {
      httpMethod: 'POST',
      path: 'form-submission',
      authentication: 'jwtAuth',
      responseMode: 'responseNode',
      options: {},
    }, { webhookId: stableId('form-submission-webhook') }),
    configNode([220, 300], [
      ['spreadsheetId', 'REPLACE_WITH_SPREADSHEET_ID'],
      ['notifyEmail', 'REPLACE_WITH_NOTIFY_EMAIL'],
      ['fromEmail', 'REPLACE_WITH_FROM_EMAIL'],
    ]),
    node('Validate Submission', 'code', 2, [440, 300], {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: validationCode,
    }, { onError: 'continueErrorOutput' }),
    node('Is Valid?', 'if', 2.2, [680, 200], {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: stableId('is-valid'),
          leftValue: '={{ $json.valid }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
        combinator: 'and',
      },
      options: {},
    }),
    node('Create Submission ID', 'crypto', 1, [900, 100], {
      action: 'hash',
      type: 'SHA256',
      value: '={{ $json.dedupe_source }}',
      dataPropertyName: 'hash',
      encoding: 'hex',
    }),
    // Reads only the ID column, so memory use stays small as the sheet grows.
    sheetsRequest('Check Existing', [1120, 100], 'GET', sheetsUrl('Submissions!A:A'),
      { majorDimension: 'COLUMNS' }, null, { onError: 'continueErrorOutput' }),
    node('Already Saved?', 'if', 2.2, [1340, 40], {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: stableId('already-saved'),
          leftValue: `={{ ($json.values?.[0] ?? []).includes(${SUBMISSION_ID}) }}`,
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
        combinator: 'and',
      },
      options: {},
    }),
    sheetsAppend('Save to Sheet', [1560, 100], 'Submissions!A:E', [
      SUBMISSION_ID,
      `${VALIDATED}.sheet.submitted_at`,
      `${VALIDATED}.sheet.name`,
      `${VALIDATED}.sheet.email`,
      `${VALIDATED}.sheet.message`,
    ], { onError: 'continueErrorOutput' }),
    // The sender gets a reply before email runs, so a slow mail server cannot affect them.
    respond('Respond Success', [1780, 40], 200, successBody),
    emailNode('Send Notification', [2000, 40],
      `=New form submission {{ ${SUBMISSION_ID} }}`,
      notificationText,
      { onError: 'continueErrorOutput', maxTries: EMAIL_MAX_TRIES }),
    flagFailure('Flag Email Failure', [2220, 40], 'Notification email could not be sent. The submission is saved.'),
    respond('Respond Duplicate', [1560, -80], 200, successBody),
    respond('Respond Unavailable', [1780, 260], 503,
      "={{ { ok: false, message: 'We could not save your submission. Please try again shortly.' } }}"),
    flagFailure('Flag Save Failure', [2000, 260], 'Submission was not saved. Recover it from this failed run.'),
    respond('Respond Rejected', [900, 340], `={{ ${VALIDATED}.statusCode }}`,
      `={{ ${VALIDATED}.response }}`),
    respond('Respond Internal Error', [680, 480], 500,
      "={{ { ok: false, message: 'Something went wrong. Please try again later.' } }}"),
    flagFailure('Flag Validation Failure', [900, 480], 'Validation crashed. Recover the submission from this failed run.'),
  ],
  connections: {
    'Form Webhook': { main: main(['Config']) },
    Config: { main: main(['Validate Submission']) },
    'Validate Submission': { main: main(['Is Valid?'], ['Respond Internal Error']) },
    'Is Valid?': { main: main(['Create Submission ID'], ['Respond Rejected']) },
    'Create Submission ID': { main: main(['Check Existing']) },
    'Check Existing': { main: main(['Already Saved?'], ['Respond Unavailable']) },
    'Already Saved?': { main: main(['Respond Duplicate'], ['Save to Sheet']) },
    'Save to Sheet': { main: main(['Respond Success'], ['Respond Unavailable']) },
    'Respond Success': { main: main(['Send Notification']) },
    'Send Notification': { main: main([], ['Flag Email Failure']) },
    'Respond Unavailable': { main: main(['Flag Save Failure']) },
    'Respond Internal Error': { main: main(['Flag Validation Failure']) },
  },
  // Failed runs are kept for recovery. Successful runs are discarded.
  settings: {
    executionOrder: 'v1',
    executionTimeout: FORM_TIMEOUT_SECONDS,
    saveDataSuccessExecution: 'none',
    saveDataErrorExecution: 'all',
    saveManualExecutions: false,
    errorWorkflow: ERROR_WORKFLOW_ID,
  },
  pinData: {},
};

const errorWorkflow = {
  id: ERROR_WORKFLOW_ID,
  name: 'Form Workflow Error Alert',
  nodes: [
    node('On Workflow Error', 'errorTrigger', 1, [0, 0], {}),
    configNode([220, 0], [
      ['spreadsheetId', 'REPLACE_WITH_SPREADSHEET_ID'],
      ['notifyEmail', 'REPLACE_WITH_NOTIFY_EMAIL'],
      ['fromEmail', 'REPLACE_WITH_FROM_EMAIL'],
    ]),
    // Two independent channels, so one outage cannot hide a failure.
    sheetsAppend('Log Failure', [440, 0], 'Failures!A:D', [
      'new Date().toISOString()',
      `${FAILURE}.workflow.name`,
      `${FAILURE}.execution.lastNodeExecuted`,
      `String(${FAILURE}.execution.id)`,
    ], { onError: 'continueRegularOutput' }),
    // Error text can quote submitted data, so the alert links to the run instead.
    emailNode('Send Error Alert', [660, 0],
      `=n8n workflow failed: {{ ${FAILURE}.workflow.name }}`,
      [
        `=Workflow: {{ ${FAILURE}.workflow.name }}`,
        `Failed node: {{ ${FAILURE}.execution.lastNodeExecuted }}`,
        `Execution: {{ ${FAILURE}.execution.id }}`,
        `Details: {{ ${FAILURE}.execution.url }}`,
      ].join('\n')),
  ],
  connections: {
    'On Workflow Error': { main: main(['Config']) },
    Config: { main: main(['Log Failure']) },
    'Log Failure': { main: main(['Send Error Alert']) },
  },
  settings: { executionOrder: 'v1', executionTimeout: 120, saveDataSuccessExecution: 'none' },
  pinData: {},
};

mkdirSync(join(root, 'workflows'), { recursive: true });
for (const [file, workflow] of [
  ['form-submission.json', formWorkflow],
  ['error-alert.json', errorWorkflow],
]) {
  writeFileSync(join(root, 'workflows', file), `${JSON.stringify(workflow, null, 2)}\n`);
}
console.log('Built workflows/form-submission.json and workflows/error-alert.json');
