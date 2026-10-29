import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const runFile = promisify(execFile);

export function mapFullAtsReceipt(receipt) {
  if (!receipt || !Array.isArray(receipt.offers)) throw new TypeError('scan-ats-full JSON receipt must contain offers[]');
  return receipt.offers.filter((offer) => offer?.url && offer?.title).map((offer) => ({
    company: offer.company ?? null,
    employer_legal_name: offer.company ?? null,
    title: offer.title,
    application_url: offer.url,
    url: offer.url,
    location: offer.location ?? null,
    posting_date: offer.postedAt ?? null,
    source: offer.source ?? 'scan-ats-full',
  }));
}

export function mapPortalReceipt(receipt) {
  if (!receipt || !Array.isArray(receipt.added_offers)) throw new TypeError('scan JSON receipt must contain added_offers[]');
  return receipt.added_offers.filter((offer) => offer?.url && offer?.title).map((offer) => ({
    company: offer.company ?? null,
    employer_legal_name: offer.company ?? null,
    title: offer.title,
    application_url: offer.url,
    url: offer.url,
    location: offer.location ?? null,
    posting_date: offer.postedAt ?? null,
    description: offer.description ?? null,
    source: offer.source ?? 'scan',
  }));
}

/** scan-ats-full reserves the final line for its receipt, but keeps progress
 * output for terminal users; locate the last JSON object instead of assuming
 * stdout is otherwise empty. */
export function parseFullAtsReceipt(stdout) {
  for (const line of String(stdout).trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line);
      if (Array.isArray(value?.offers)) return value;
    } catch { /* progress line, not the receipt */ }
  }
  throw new TypeError('Scanner did not emit a valid JSON receipt');
}

export async function runFullAtsDryRun({ root, stage, limit = 100, execFileFn = runFile } = {}) {
  if (!root || !stage) throw new TypeError('root and stage are required');
  const args = [join(root, 'scan-ats-full.mjs'), '--dry-run', '--json', '--since', String(stage.posting_age_days), '--limit', String(limit)];
  let stdout;
  try { ({ stdout } = await execFileFn(process.execPath, args, { cwd: root, maxBuffer: 10 * 1024 * 1024 })); } catch (error) {
    return { candidates: [], sources: [{ id: 'scan-ats-full', status: 'error', message: String(error?.stderr ?? error?.message ?? error).slice(0, 500) }], note: 'Scanner command failed' };
  }
  let receipt;
  try { receipt = parseFullAtsReceipt(stdout); } catch { return { candidates: [], sources: [{ id: 'scan-ats-full', status: 'invalid_receipt' }], note: 'Scanner did not emit a valid JSON receipt' }; }
  const noUsableDataset = Object.values(receipt.datasetStatus ?? {}).some((status) => status === 'empty');
  return { candidates: mapFullAtsReceipt(receipt), sources: [{ id: 'scan-ats-full', status: receipt.stoppedByOutage || noUsableDataset ? 'degraded' : 'ok', postings_kept: receipt.postingsKept ?? receipt.offers.length, since_days: stage.posting_age_days }], note: receipt.stoppedByOutage ? 'Reverse-ATS scan stopped by outage; checkpoint may be available.' : (noUsableDataset ? 'One or more public ATS datasets were unavailable.' : null) };
}

export async function runPortalScanDryRun({ root, stage, countryCoverage = {}, execFileFn = runFile } = {}) {
  if (!root || !stage) throw new TypeError('root and stage are required');
  const args = [join(root, 'scan.mjs'), '--dry-run', '--json', '--quiet', '--since', String(stage.posting_age_days)];
  let stdout;
  try { ({ stdout } = await execFileFn(process.execPath, args, { cwd: root, maxBuffer: 10 * 1024 * 1024 })); } catch (error) {
    return { candidates: [], sources: [{ id: 'scan', status: 'error', message: String(error?.stderr ?? error?.message ?? error).slice(0, 500) }], note: 'Portal scanner command failed' };
  }
  let receipt;
  try { receipt = parsePortalReceipt(stdout); } catch { return { candidates: [], sources: [{ id: 'scan', status: 'invalid_receipt' }], note: 'Portal scanner did not emit a valid JSON receipt' }; }
  return { candidates: mapPortalReceipt(receipt), sources: [{ id: 'scan', status: receipt.errors?.length ? 'degraded' : 'ok', found: receipt.found ?? 0, added: receipt.added ?? 0, countries: countryCoverage }], note: receipt.errors?.length ? `${receipt.errors.length} portal sources failed` : null };
}

export function parsePortalReceipt(stdout) {
  for (const line of String(stdout).trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line);
      if (Array.isArray(value?.added_offers) && value?.version === 'careerops.scan.receipt@1') return value;
    } catch { /* progress line, not the receipt */ }
  }
  throw new TypeError('Portal scanner did not emit a valid JSON receipt');
}
