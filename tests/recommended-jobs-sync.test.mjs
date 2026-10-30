import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pass, fail } from './helpers.mjs';
import { RECOMMENDED_JOBS_HEADERS, recommendedJobPayload, syncRecommendedJobs } from '../lib/recommended-jobs-sync.mjs';

console.log('\nrecommended-jobs sync — append-only, idempotent Sheets export');
async function check(label, fn) { try { await fn(); pass(label); } catch (error) { fail(`${label} — ${error.message}`); } }
function record(score = 80) {
  return {
    company: 'Example B.V.', employer_legal_name: 'Example B.V.', title: 'Platform Engineer', country: 'Netherlands', location: 'Amsterdam', application_url: 'https://jobs.example.test/123?utm_source=test&jobId=123', posting_date: '2026-10-28',
    assessment: { accepted: true, application_ready: true, evaluation: { match_score: score }, verification: { posting_date: { value: '2026-10-28' }, immigration: { classification: 'confirmed_employer_eligible', evidence: [{ url: 'https://ind.example.test/register' }] } } },
  };
}
function fakeClient({ ambiguous = false, badHeader = false } = {}) {
  const rows = [];
  const calls = [];
  return {
    rows, calls,
    getSpreadsheetMetadata: async () => ({ sheets: [{ properties: { sheetId: 1972763707, title: 'Recommended Jobs', gridProperties: { rowCount: 20, columnCount: 13, frozenRowCount: 1 } } }] }),
    getValues: async (_id, range) => {
      calls.push({ type: 'get', range });
      if (range.endsWith('A1:M1')) return { values: [badHeader ? ['Wrong'] : RECOMMENDED_JOBS_HEADERS] };
      return { values: [RECOMMENDED_JOBS_HEADERS.slice(1), ...rows] };
    },
    updateValues: async (_id, range, values) => {
      calls.push({ type: 'update', range, values });
      rows.push(values[0]);
      if (ambiguous) throw new Error('connection reset after request');
      return { updates: { updatedRange: "'Recommended Jobs'!B21:M21" } };
    },
    setRangeBackgroundWhite: async (_id, sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex) => {
      calls.push({ type: 'white', sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex });
    },
  };
}

await check('writes B:M only, verifies readback, and never duplicates a verified ledger entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-sheet-sync-'));
  try {
    const client = fakeClient(); const input = record();
    const first = await syncRecommendedJobs({ client, spreadsheetId: 'sheet-id', records: [input], ledgerPath: join(dir, 'ledger.jsonl'), now: new Date('2026-10-29T12:00:00Z') });
    assert.equal(first.written.length, 1); assert.equal(first.failed.length, 0); assert.equal(client.rows.length, 1);
    assert.equal(client.calls.filter((call) => call.type === 'update')[0].range, "'Recommended Jobs'!B2:M2");
    assert.deepEqual(client.calls.filter((call) => call.type === 'white')[0], { type: 'white', sheetId: 1972763707, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 13 });
    assert.equal(client.rows[0].length, 12); assert.equal(client.rows[0][7].startsWith('url:https://'), true);
    const second = await syncRecommendedJobs({ client, spreadsheetId: 'sheet-id', records: [input], ledgerPath: join(dir, 'ledger.jsonl'), now: new Date('2026-10-29T12:00:00Z') });
    assert.equal(second.skipped[0].reason, 'already_exported'); assert.equal(client.rows.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
await check('ambiguous append response is recovered by readback without a second append', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-sheet-sync-'));
  try {
    const client = fakeClient({ ambiguous: true });
    const result = await syncRecommendedJobs({ client, spreadsheetId: 'sheet-id', records: [record()], ledgerPath: join(dir, 'ledger.jsonl') });
    assert.equal(result.written[0].recovered, true); assert.equal(client.calls.filter((call) => call.type === 'update').length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
await check('rejects schema mismatch and ineligible records before append', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-sheet-sync-'));
  try {
    await assert.rejects(() => syncRecommendedJobs({ client: fakeClient({ badHeader: true }), spreadsheetId: 'sheet-id', records: [record()], ledgerPath: join(dir, 'ledger.jsonl') }), /headers A:M/);
    const client = fakeClient(); const result = await syncRecommendedJobs({ client, spreadsheetId: 'sheet-id', records: [record(74)], ledgerPath: join(dir, 'ledger.jsonl') });
    assert.equal(result.skipped[0].reason, 'not_export_eligible'); assert.equal(client.calls.some((call) => call.type === 'update'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
await check('payload uses Tunisia date and marks unavailable posting dates as Unknown', () => {
  const value = recommendedJobPayload({ ...record(), posting_date: null, assessment: { ...record().assessment, verification: { ...record().assessment.verification, posting_date: { value: null } } } }, { now: new Date('2026-10-29T23:30:00Z') });
  assert.equal(value.values[0], '2026-10-30'); assert.equal(value.values[5], 'Unknown');
});
await check('payload derives a configured country from an unambiguous location', () => {
  const value = recommendedJobPayload({ ...record(), country: null, location: 'Paris, France, Remote' });
  assert.equal(value.values[3], 'France');
});
