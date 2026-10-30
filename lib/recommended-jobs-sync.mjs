import { createHash } from 'node:crypto';
import { dailyCandidateIdentity } from './daily-candidate-identity.mjs';
import { inferDailyCandidateCountry } from './daily-country.mjs';
import { appendExportLedgerEvent, latestExportEvents, readExportLedger } from './sheet-export-ledger.mjs';

export const RECOMMENDED_JOBS_HEADERS = ['Job #', 'Sent Date (Tunisia)', 'Employer (legal name)', 'Job Title', 'Country', 'Location', 'Posting Date', 'Application URL', 'Dedup Key', 'Match /100', 'Immigration Route', 'Sponsor Evidence URL', 'Salary (advertised)'];
export const RECOMMENDED_JOBS_TAB = 'Recommended Jobs';

function cell(value) { return value === null || value === undefined ? '' : String(value); }
function tunisDate(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function payloadHash(values) { return createHash('sha256').update(JSON.stringify(values)).digest('hex'); }
function sponsorEvidence(verification) { return verification?.immigration?.evidence?.find((item) => item?.url)?.url ?? ''; }
function padded(values) { return Array.from({ length: 12 }, (_, index) => cell(values?.[index])); }

export function validateRecommendedJobsSheet(metadata, headerValues, { tab = RECOMMENDED_JOBS_TAB } = {}) {
  const sheet = metadata?.sheets?.find((entry) => entry?.properties?.title === tab);
  if (!sheet) throw new Error(`Required Google Sheet tab is missing: ${tab}`);
  if ((sheet.properties.gridProperties?.columnCount ?? 0) < 13) throw new Error(`${tab} must have at least columns A:M`);
  const headers = headerValues?.values?.[0] ?? [];
  if (JSON.stringify(headers.slice(0, 13)) !== JSON.stringify(RECOMMENDED_JOBS_HEADERS)) throw new Error(`${tab} headers A:M do not match the required append-only schema`);
  return { sheet_id: sheet.properties.sheetId, row_count: sheet.properties.gridProperties?.rowCount ?? 0 };
}

export function recommendedJobPayload(record, { now = new Date() } = {}) {
  const candidate = record?.candidate ?? record;
  const assessment = record?.assessment ?? candidate?.assessment;
  const verification = assessment?.verification ?? record?.verification;
  const evaluation = assessment?.evaluation ?? record?.evaluation;
  if (assessment?.accepted !== true || assessment?.application_ready !== true || !Number.isInteger(evaluation?.match_score) || evaluation.match_score < 75) return null;
  if (!candidate?.employer_legal_name && !candidate?.company) return null;
  const country = candidate?.country ?? inferDailyCandidateCountry(candidate);
  if (!candidate?.title || !country || !candidate?.location || !candidate?.application_url) return null;
  const identity = dailyCandidateIdentity(candidate);
  const values = [tunisDate(now), candidate.employer_legal_name ?? candidate.company, candidate.title, country, candidate.location, verification?.posting_date?.value ?? candidate.posting_date ?? 'Unknown', candidate.application_url, identity.primary, evaluation.match_score, verification?.immigration?.classification ?? evaluation?.immigration?.classification ?? 'unknown', sponsorEvidence(verification), candidate.salary ?? candidate.advertised_salary ?? ''];
  return { dedup_key: identity.primary, values: values.map(cell), payload_hash: payloadHash(values), identity };
}

function rowsByDedup(values) {
  const rows = new Map();
  for (const row of values?.values?.slice(1) ?? []) {
    const cells = padded(row);
    if (cells[7]) rows.set(cells[7], cells);
  }
  return rows;
}

async function currentRows(client, spreadsheetId, tab, rowCount) {
  const end = Math.max(2, rowCount);
  return rowsByDedup(await client.getValues(spreadsheetId, `'${tab}'!B1:M${end}`));
}

async function nextAppendRow(client, spreadsheetId, tab, rowCount) {
  const end = Math.max(2, rowCount);
  const values = (await client.getValues(spreadsheetId, `'${tab}'!B1:M${end}`)).values ?? [];
  let lastPopulated = 1; // row 1 is the header and is never an export target.
  for (let index = 1; index < values.length; index++) {
    if (padded(values[index]).some(Boolean)) lastPopulated = index + 1;
  }
  return lastPopulated + 1;
}

export async function syncRecommendedJobs({ client, spreadsheetId, records, ledgerPath, tab = RECOMMENDED_JOBS_TAB, now = new Date() } = {}) {
  if (!client || !spreadsheetId || !ledgerPath) throw new TypeError('client, spreadsheetId, and ledgerPath are required');
  const metadata = await client.getSpreadsheetMetadata(spreadsheetId);
  const header = await client.getValues(spreadsheetId, `'${tab}'!A1:M1`);
  const sheet = validateRecommendedJobsSheet(metadata, header, { tab });
  const existing = await currentRows(client, spreadsheetId, tab, sheet.row_count);
  const latest = latestExportEvents(readExportLedger(ledgerPath));
  const result = { written: [], skipped: [], failed: [] };
  for (const record of records ?? []) {
    const payload = recommendedJobPayload(record, { now });
    if (!payload) { result.skipped.push({ reason: 'not_export_eligible' }); continue; }
    if (latest.get(payload.dedup_key)?.event === 'verified') {
      result.skipped.push({ dedup_key: payload.dedup_key, reason: 'already_exported' }); continue;
    }
    if (existing.has(payload.dedup_key)) {
      // A prior process may have committed the row but failed before its
      // ledger verification (for example during a response-format change).
      await appendExportLedgerEvent(ledgerPath, { event: 'verified', dedup_key: payload.dedup_key, payload_hash: payload.payload_hash, recovery: 'existing_sheet_row' });
      result.skipped.push({ dedup_key: payload.dedup_key, reason: 'already_exported' }); continue;
    }
    await appendExportLedgerEvent(ledgerPath, { event: 'reserved', dedup_key: payload.dedup_key, payload_hash: payload.payload_hash });
    try {
      const row = await nextAppendRow(client, spreadsheetId, tab, sheet.row_count);
      // Status colour belongs to the user. Establish a neutral background for
      // each new B:M record before writing values; existing records are never
      // reformatted because they are skipped by the deduplication guard.
      await client.setRangeBackgroundWhite(spreadsheetId, sheet.sheet_id, row - 1, row, 1, 13);
      const response = await client.updateValues(spreadsheetId, `'${tab}'!B${row}:M${row}`, [payload.values]);
      await appendExportLedgerEvent(ledgerPath, { event: 'written', dedup_key: payload.dedup_key, payload_hash: payload.payload_hash, updated_range: response?.updates?.updatedRange ?? null });
    } catch (error) {
      // The append response may be lost after Google commits. Re-read before
      // recording a retryable failure; never send a second append here.
      const recovered = await currentRows(client, spreadsheetId, tab, sheet.row_count + 20).catch(() => new Map());
      if (recovered.has(payload.dedup_key)) {
        await appendExportLedgerEvent(ledgerPath, { event: 'verified', dedup_key: payload.dedup_key, payload_hash: payload.payload_hash, recovery: 'ambiguous_append_readback' });
        result.written.push({ dedup_key: payload.dedup_key, recovered: true });
      } else {
        await appendExportLedgerEvent(ledgerPath, { event: 'failed', dedup_key: payload.dedup_key, payload_hash: payload.payload_hash, retryable: true, error: String(error.message ?? error).slice(0, 300) });
        result.failed.push({ dedup_key: payload.dedup_key, error: String(error.message ?? error) });
      }
      continue;
    }
    const readback = await currentRows(client, spreadsheetId, tab, sheet.row_count + 20);
    const row = readback.get(payload.dedup_key);
    if (row && JSON.stringify(row) === JSON.stringify(payload.values)) {
      await appendExportLedgerEvent(ledgerPath, { event: 'verified', dedup_key: payload.dedup_key, payload_hash: payload.payload_hash });
      result.written.push({ dedup_key: payload.dedup_key, recovered: false });
    } else {
      await appendExportLedgerEvent(ledgerPath, { event: 'failed', dedup_key: payload.dedup_key, payload_hash: payload.payload_hash, retryable: false, error: 'read-after-write mismatch' });
      result.failed.push({ dedup_key: payload.dedup_key, error: 'read-after-write mismatch' });
    }
  }
  return result;
}
