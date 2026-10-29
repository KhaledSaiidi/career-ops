#!/usr/bin/env node
/**
 * Daily discovery controller. Phase 5 deliberately accepts an explicit
 * fixture/input adapter rather than silently launching broad network scans.
 * Later source adapters will feed the same controller with scan.mjs receipts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadYaml } from './lib/yaml-document.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { readDailyRunStore, writeDailyRunStore } from './lib/daily-run-store.mjs';
import { runProgressiveSearch } from './lib/progressive-search.mjs';
import { runFullAtsDryRun, runPortalScanDryRun } from './lib/scanner-receipt-adapter.mjs';
import { assessDailyCandidate } from './lib/daily-candidate-assessor.mjs';
import { createGoogleSheetsClientFromCredentials } from './lib/google-sheets-client.mjs';
import { syncRecommendedJobs } from './lib/recommended-jobs-sync.mjs';

const USAGE = `Usage:
  node daily-discovery.mjs --fixture <staged-candidates.json> [--persist-state] [--state <path>]
  node daily-discovery.mjs --live-scan [--source portals|full-ats] [--evaluate] [--max-stages N] [--persist-state] [--state <path>] [--write-sheet]

--live-scan runs the selected scanner with --dry-run --json only. It never writes
pipeline/history/Sheets. --evaluate is explicit because it sends the CV and JD
to the configured evaluator (Codex CLI by default); without it candidates are verified only.
Live scan defaults to one stage; pass --max-stages 8 only after validating
source budgets and configured evaluator availability.`;
function value(args, flag) { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; }
function json(path) { return JSON.parse(readFileSync(path, 'utf8')); }

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }
  const fixturePath = value(args, '--fixture');
  const liveScan = args.includes('--live-scan');
  if (Boolean(fixturePath) === liveScan || (fixturePath && !existsSync(fixturePath))) throw new Error(`${USAGE}\nChoose exactly one source: --fixture or --live-scan.`);
  const root = getCareerOpsRoot();
  loadDotenv({ path: join(root, '.env'), quiet: true });
  const config = loadYaml(readFileSync(join(root, 'config', 'daily-discovery.yml'), 'utf8'));
  const fixture = fixturePath ? json(fixturePath) : null;
  const statePath = value(args, '--state') ?? join(root, 'data', 'daily-discovery-state.json');
  // Dry-run is the safe default: this phase must not create discovery state
  // unless an operator explicitly enables restart persistence.
  const persist = args.includes('--persist-state');
  const state = persist ? readDailyRunStore(statePath) : { version: 2, processed: {}, identity_index: {}, pending_exports: {}, runs: {} };
  const evaluate = args.includes('--evaluate');
  const evaluatorBackend = config.evaluation?.backend ?? 'codex-cli';
  if (evaluate && evaluatorBackend === 'openai-api' && !process.env.OPENAI_API_KEY) throw new Error('--evaluate with openai-api requires OPENAI_API_KEY; no request was sent');
  const source = value(args, '--source') ?? 'portals';
  if (!['portals', 'full-ats'].includes(source)) throw new Error('--source must be portals or full-ats');
  const maxStagesRaw = value(args, '--max-stages');
  const maxStages = maxStagesRaw === null ? (liveScan ? 1 : undefined) : Number(maxStagesRaw);
  if (maxStages !== undefined && (!Number.isInteger(maxStages) || maxStages < 1 || maxStages > 8)) throw new Error('--max-stages must be an integer from 1 to 8');
  const { report, state: next } = await runProgressiveSearch({
    config, state,
    discover: async (stage) => fixture ? (fixture[stage.name] ?? { candidates: [], sources: [], note: 'No fixture candidates for stage' }) : source === 'portals'
      ? runPortalScanDryRun({ root, stage, countryCoverage: config.discovery?.country_source_coverage ?? {} })
      : runFullAtsDryRun({ root, stage }),
    assess: async (candidate) => fixture ? (candidate.assessment ?? { accepted: false, application_ready: false, decision: 'not_assessed' }) : assessDailyCandidate(candidate, { root, evaluate, backend: evaluatorBackend }),
    ...(maxStages === undefined ? {} : { maxStages }),
  });
  // Persist accepted records before a remote write. If the process or network
  // fails during export, the next explicit export can resume from pending state.
  if (persist) writeDailyRunStore(statePath, next);
  let sheetSync = null;
  if (args.includes('--write-sheet')) {
    if (!persist) throw new Error('--write-sheet requires --persist-state so failed exports remain retryable');
    if (config.discovery?.write_google_sheet !== true) throw new Error('Set discovery.write_google_sheet: true only when ready to enable live Google Sheets writes');
    const spreadsheetId = config.sheets?.spreadsheet_id;
    const credentialPath = process.env[config.sheets?.service_account_credentials_env ?? 'GOOGLE_APPLICATION_CREDENTIALS'];
    const ledgerPath = join(root, 'data', 'daily-discovery-export-ledger.jsonl');
    const client = createGoogleSheetsClientFromCredentials(credentialPath);
    sheetSync = await syncRecommendedJobs({ client, spreadsheetId, records: Object.values(next.pending_exports ?? {}), ledgerPath, tab: config.sheets?.tab ?? 'Recommended Jobs' });
    for (const row of [...sheetSync.written, ...sheetSync.skipped.filter((entry) => entry.reason === 'already_exported')]) delete next.pending_exports?.[row.dedup_key];
  }
  if (persist && sheetSync) writeDailyRunStore(statePath, next);
  process.stdout.write(`${JSON.stringify({ ...report, state_persisted: persist, sheet_sync: sheetSync }, null, 2)}\n`);
}
main().catch((error) => { console.error(`daily-discovery: ${error.message}`); process.exitCode = 1; });
