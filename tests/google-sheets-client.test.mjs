import assert from 'node:assert/strict';
import { pass, fail } from './helpers.mjs';
import { createGoogleSheetsClient } from '../lib/google-sheets-client.mjs';

console.log('\ngoogle Sheets client — bounded API paths and retry policy');
async function check(label, fn) { try { await fn(); pass(label); } catch (error) { fail(`${label} — ${error.message}`); } }
function response(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
await check('GET retries transient failure while append does not retry ambiguous writes', async () => {
  const calls = []; let metadataAttempts = 0;
  const client = createGoogleSheetsClient({ tokenProvider: async () => 'token', sleepFn: async () => {}, fetchFn: async (url, options) => {
    calls.push({ url, options });
    if (url.includes(':append')) return response(503, { error: { message: 'temporary' } });
    metadataAttempts++; return metadataAttempts === 1 ? response(429, { error: { message: 'rate limited' } }) : response(200, { sheets: [] });
  } });
  await client.getSpreadsheetMetadata('sheet');
  await assert.rejects(() => client.appendValues('sheet', "'Recommended Jobs'!B:M", [['x']]), /503/);
  assert.equal(metadataAttempts, 2); assert.equal(calls.filter((call) => call.url.includes(':append')).length, 1);
});
