#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { loadYaml } from './lib/yaml-document.mjs';
import { createGoogleSheetsClientFromCredentials } from './lib/google-sheets-client.mjs';
import { recommendedJobPayload, syncRecommendedJobs } from './lib/recommended-jobs-sync.mjs';

const USAGE = 'Usage: node sync-recommended-jobs.mjs --input <accepted-records.json> --write\n\nWithout --write, prints export-eligible payloads only. --write performs append-only B:M synchronization.';
function value(args, flag) { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; }

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) return console.log(USAGE);
  const inputPath = value(args, '--input');
  if (!inputPath) throw new Error(USAGE);
  const root = getCareerOpsRoot();
  loadDotenv({ path: join(root, '.env'), quiet: true });
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
  const records = Array.isArray(input) ? input : input.accepted;
  if (!Array.isArray(records)) throw new Error('Input must be an array or an object with accepted[]');
  const config = loadYaml(readFileSync(join(root, 'config', 'daily-discovery.yml'), 'utf8'));
  if (!args.includes('--write')) return process.stdout.write(`${JSON.stringify(records.map((record) => recommendedJobPayload(record)).filter(Boolean), null, 2)}\n`);
  if (config.discovery?.write_google_sheet !== true) throw new Error('Set discovery.write_google_sheet: true before using --write');
  const credentialsPath = process.env[config.sheets?.service_account_credentials_env ?? 'GOOGLE_APPLICATION_CREDENTIALS'];
  const result = await syncRecommendedJobs({ client: createGoogleSheetsClientFromCredentials(credentialsPath), spreadsheetId: config.sheets?.spreadsheet_id, records, ledgerPath: join(root, 'data', 'daily-discovery-export-ledger.jsonl'), tab: config.sheets?.tab ?? 'Recommended Jobs' });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
main().catch((error) => { console.error(`sync-recommended-jobs: ${error.message}`); process.exitCode = 1; });
