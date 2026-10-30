import assert from 'node:assert/strict';
import { pass, fail } from './helpers.mjs';
import { mapFullAtsReceipt, mapPortalReceipt, parseFullAtsReceipt, parsePortalReceipt, runFullAtsDryRun, runPortalScanDryRun } from '../lib/scanner-receipt-adapter.mjs';

console.log('\nscanner receipt adapter — safe dry-run mapping');
async function check(label, fn) { try { await fn(); pass(label); } catch (error) { fail(`${label} — ${error.message}`); } }
const receipt = { postingsKept: 1, stoppedByOutage: false, offers: [{ company: 'Acme B.V.', title: 'Platform Engineer', url: 'https://jobs.acme.test/1', location: 'Amsterdam', postedAt: '2026-10-28', source: 'greenhouse-full' }] };
const portalReceipt = { version: 'careerops.scan.receipt@1', found: 1, added: 1, errors: [], added_offers: [{ company: 'Acme B.V.', title: 'Platform Engineer', url: 'https://jobs.acme.test/1', location: 'Amsterdam', postedAt: '2026-10-28', description: 'Kubernetes role', source: 'wttj' }] };
await check('maps only complete scanner offers to verification candidates', () => {
  const [candidate] = mapFullAtsReceipt(receipt);
  assert.equal(candidate.application_url, 'https://jobs.acme.test/1');
  assert.equal(candidate.posting_date, '2026-10-28');
  assert.deepEqual(mapFullAtsReceipt({ offers: [{ title: 'Missing URL' }] }), []);
});
await check('runs scan-ats-full in dry-run JSON mode and reports its source receipt', async () => {
  const calls = [];
  const result = await runFullAtsDryRun({ root: '/repo', stage: { posting_age_days: 7 }, execFileFn: async (...args) => { calls.push(args); return { stdout: JSON.stringify(receipt) }; } });
  assert.deepEqual(calls[0][1].slice(1), ['--dry-run', '--json', '--since', '7', '--limit', '100']);
  assert.equal(result.candidates.length, 1); assert.equal(result.sources[0].status, 'ok');
});
await check('extracts the final scanner receipt after human progress output', () => {
  assert.equal(parseFullAtsReceipt(`progress\n${JSON.stringify(receipt)}\nsummary`).offers.length, 1);
});
await check('maps portal dry-run offers and retains configured country provenance', async () => {
  assert.equal(mapPortalReceipt(portalReceipt)[0].source, 'wttj');
  assert.equal(mapPortalReceipt(portalReceipt)[0].description, 'Kubernetes role');
  assert.equal(mapPortalReceipt({ ...portalReceipt, added_offers: [{ ...portalReceipt.added_offers[0], location: 'Paris, France' }] })[0].country, 'France');
  assert.equal(parsePortalReceipt(`progress\n${JSON.stringify(portalReceipt)}`).added, 1);
  const result = await runPortalScanDryRun({ root: '/repo', stage: { posting_age_days: 7 }, countryCoverage: { Sweden: ['The Hub'] }, execFileFn: async () => ({ stdout: JSON.stringify(portalReceipt) }) });
  assert.deepEqual(result.sources[0].countries, { Sweden: ['The Hub'] });
  assert.equal(result.candidates.length, 1);
});
await check('turns a malformed scanner receipt into an auditable no-candidate result', async () => {
  const result = await runFullAtsDryRun({ root: '/repo', stage: { posting_age_days: 7 }, execFileFn: async () => ({ stdout: 'not json' }) });
  assert.equal(result.sources[0].status, 'invalid_receipt');
});
