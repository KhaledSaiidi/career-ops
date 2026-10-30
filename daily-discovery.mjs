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
import { dailyExitCode, writeDailyRunReport } from './lib/daily-report.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const USAGE = `Usage:
  node daily-discovery.mjs --fixture <staged-candidates.json> [--persist-state] [--state <path>]
  node daily-discovery.mjs --live-scan [--source portals|full-ats] [--evaluate] [--max-stages N] [--max-candidates N] [--persist-state] [--state <path>] [--write-sheet]

--live-scan runs the selected scanner with --dry-run --json only. It never writes
pipeline/history/Sheets. --evaluate is explicit because it sends the CV and JD
to the configured evaluator (Codex CLI by default); without it candidates are verified only.
Live scans use all progressive stages and evaluate every verified, unique
candidate returned by each attempted source. --max-stages and
--max-candidates are optional operator limits for diagnostics only.`;
function value(args, flag) { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; }
function json(path) { return JSON.parse(readFileSync(path, 'utf8')); }
export function parseDailySourceArgs(args) {
  const fixturePath = value(args, '--fixture');
  const liveScan = args.includes('--live-scan');
  if (Boolean(fixturePath) === liveScan || (fixturePath && !existsSync(fixturePath))) throw new Error(`${USAGE}\nChoose exactly one source: --fixture or --live-scan.`);
  return { fixturePath, liveScan };
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }
  const startedAt = new Date().toISOString();
  let root;
  try {
    const { fixturePath, liveScan } = parseDailySourceArgs(args);
    root = getCareerOpsRoot();
    loadDotenv({ path: join(root, '.env'), quiet: true });
    const config = loadYaml(readFileSync(join(root, 'config', 'daily-discovery.yml'), 'utf8'));
    const fixture = fixturePath ? json(fixturePath) : null;
    const statePath = value(args, '--state') ?? join(root, 'data', 'daily-discovery-state.json');
  // Dry-run is the safe default: this phase must not create discovery state
  // unless an operator explicitly enables restart persistence.
    const persist = args.includes('--persist-state');
    if (args.includes('--write-sheet') && !persist) throw new Error('--write-sheet requires --persist-state so failed exports remain retryable');
    if (args.includes('--write-sheet') && config.discovery?.write_google_sheet !== true) throw new Error('Set discovery.write_google_sheet: true only when ready to enable live Google Sheets writes');
    const state = persist ? readDailyRunStore(statePath) : { version: 2, processed: {}, identity_index: {}, pending_exports: {}, runs: {} };
    const evaluate = args.includes('--evaluate');
    const evaluatorBackend = config.evaluation?.backend ?? 'codex-cli';
    if (evaluate && evaluatorBackend === 'openai-api' && !process.env.OPENAI_API_KEY) throw new Error('--evaluate with openai-api requires OPENAI_API_KEY; no request was sent');
    const source = value(args, '--source') ?? 'portals';
    if (!['portals', 'full-ats'].includes(source)) throw new Error('--source must be portals or full-ats');
    const maxStagesRaw = value(args, '--max-stages');
    const maxStages = maxStagesRaw === null ? undefined : Number(maxStagesRaw);
    if (maxStages !== undefined && (!Number.isInteger(maxStages) || maxStages < 1 || maxStages > 8)) throw new Error('--max-stages must be an integer from 1 to 8');
    const maxCandidatesRaw = value(args, '--max-candidates');
    const maxCandidates = maxCandidatesRaw === null ? undefined : Number(maxCandidatesRaw);
    if (maxCandidates !== undefined && (!Number.isInteger(maxCandidates) || maxCandidates < 1)) throw new Error('--max-candidates must be a positive integer');
    const { report, state: next } = await runProgressiveSearch({
    config, state,
    discover: async (stage) => fixture ? (fixture[stage.name] ?? { candidates: [], sources: [], note: 'No fixture candidates for stage' }) : source === 'portals'
      ? runPortalScanDryRun({ root, stage, countryCoverage: config.discovery?.country_source_coverage ?? {} })
      : runFullAtsDryRun({ root, stage }),
    assess: async (candidate) => fixture ? (candidate.assessment ?? { accepted: false, application_ready: false, decision: 'not_assessed' }) : assessDailyCandidate(candidate, { root, evaluate, backend: evaluatorBackend }),
    ...(maxStages === undefined ? {} : { maxStages }),
    ...(maxCandidates === undefined ? {} : { maxCandidates }),
    });
  // Persist accepted records before a remote write. If the process or network
  // fails during export, the next explicit export can resume from pending state.
    if (persist) writeDailyRunStore(statePath, next);
    let sheetSync = null;
    if (args.includes('--write-sheet')) {
    const spreadsheetId = config.sheets?.spreadsheet_id;
    const credentialPath = process.env[config.sheets?.service_account_credentials_env ?? 'GOOGLE_APPLICATION_CREDENTIALS'];
    const ledgerPath = join(root, 'data', 'daily-discovery-export-ledger.jsonl');
    const client = createGoogleSheetsClientFromCredentials(credentialPath);
    sheetSync = await syncRecommendedJobs({ client, spreadsheetId, records: Object.values(next.pending_exports ?? {}), ledgerPath, tab: config.sheets?.tab ?? 'Recommended Jobs' });
    for (const row of [...sheetSync.written, ...sheetSync.skipped.filter((entry) => entry.reason === 'already_exported')]) delete next.pending_exports?.[row.dedup_key];
    }
    if (persist && sheetSync) writeDailyRunStore(statePath, next);
    const artifacts = writeDailyRunReport(root, { report, sheet_sync: sheetSync, status: sheetSync?.failed?.length ? 'partial' : 'success', started_at: startedAt });
    process.stdout.write(`${JSON.stringify({ ...report, state_persisted: persist, sheet_sync: sheetSync, report_files: { json: artifacts.json_path, markdown: artifacts.markdown_path } }, null, 2)}\n`);
    process.exitCode = dailyExitCode({ summary: artifacts.summary });
  } catch (error) {
    const reportRoot = root ?? getCareerOpsRoot();
    const artifacts = writeDailyRunReport(reportRoot, { status: 'failed', started_at: startedAt, error: error.message, report: { attempts: [], accepted: [], rejected: [], shortfall: null } });
    console.error(`daily-discovery: ${error.message}`);
    console.error(`daily-discovery: report: ${artifacts.markdown_path}`);
    process.exitCode = dailyExitCode({ error });
  }
}
if (isMainModule(import.meta.url)) await main();
