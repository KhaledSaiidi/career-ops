#!/usr/bin/env node
/**
 * Evaluate one verified job JSON payload against the local CV/profile.
 * This command never submits an application or writes a tracker/Sheet row.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadYaml } from './lib/yaml-document.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { requestStructuredJson } from './lib/openai-client.mjs';
import { EUROPE_EVALUATION_JSON_SCHEMA, buildEuropeanEvaluationMessages, decideEuropeanJob, evaluationCacheKey, readEvaluationCache, validateEuropeanEvaluation, writeEvaluationCache } from './lib/europe-job-evaluator.mjs';

loadDotenv();

const USAGE = `Usage: node evaluate-europe-job.mjs --job <job.json> [--output <result.json>] [--no-cache]

job.json must contain at least: { "description": "..." }.
Optional fields: company, title, url, listing_fingerprint, country, location.`;

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new Error(`Could not read job JSON ${path}: ${error.message}`); }
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const jobPath = argValue(args, '--job');
  if (!jobPath) { console.error(USAGE); return 1; }
  const outputPath = argValue(args, '--output');
  const noCache = args.includes('--no-cache');
  const root = getCareerOpsRoot();
  const cvPath = join(root, 'cv.md');
  const profilePath = join(root, 'config', 'profile.yml');
  if (!existsSync(cvPath) || !existsSync(profilePath)) throw new Error('cv.md and config/profile.yml are required');
  const job = readJson(jobPath);
  const cvText = readFileSync(cvPath, 'utf8');
  const profileText = JSON.stringify(loadYaml(readFileSync(profilePath, 'utf8')) ?? {});
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const listingFingerprint = typeof job.listing_fingerprint === 'string' && job.listing_fingerprint
    ? job.listing_fingerprint
    : createHash('sha256').update(String(job.url || job.description || '')).digest('hex');
  const key = evaluationCacheKey({ listingFingerprint, jobDescription: String(job.description || ''), cvText, profileText, model });
  const cachePath = join(root, 'data', 'europe-evaluation-cache.json');
  let evaluation;
  let cache = 'miss';
  if (!noCache) {
    const hit = readEvaluationCache(cachePath, key);
    if (hit) { evaluation = hit.evaluation; cache = 'hit'; }
  }
  let request = null;
  if (!evaluation) {
    request = await requestStructuredJson({
      apiKey: process.env.OPENAI_API_KEY,
      model,
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 90_000),
      messages: buildEuropeanEvaluationMessages({ job, cvText, profileText }),
      schema: EUROPE_EVALUATION_JSON_SCHEMA,
      validate: validateEuropeanEvaluation,
    });
    evaluation = request.value;
    const checked = validateEuropeanEvaluation(evaluation);
    if (!checked.valid) throw new Error(`Model result failed evaluator contract: ${checked.errors.join('; ')}`);
    if (!noCache) writeEvaluationCache(cachePath, key, evaluation);
  }
  const result = { job: { company: job.company ?? null, title: job.title ?? null, url: job.url ?? null, listing_fingerprint: listingFingerprint }, cache, evaluation, decision: decideEuropeanJob(evaluation), model: request?.model ?? model, usage: request?.usage ?? null, attempts: request?.attempts ?? 0 };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, json, 'utf8');
  }
  process.stdout.write(json);
  return 0;
}

main().catch((error) => { console.error(`evaluate-europe-job: ${error.message}`); process.exitCode = 1; });
