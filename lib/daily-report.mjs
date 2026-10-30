import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function tunisDate(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function atomicWrite(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, value, 'utf8');
  renameSync(temp, path);
}
function count(rejected, matcher) { return rejected.filter((entry) => matcher(entry.reason ?? '')).length; }
function score(record) { return record?.assessment?.evaluation?.match_score ?? record?.evaluation?.match_score ?? -1; }
function countryCounts(accepted) {
  const counts = {};
  for (const entry of accepted) { const country = entry.country ?? 'Unknown'; counts[country] = (counts[country] ?? 0) + 1; }
  return counts;
}

export function summarizeDailyRun({ report = {}, sheet_sync: sheetSync = null, status = 'success', error = null, started_at = null, finished_at = new Date().toISOString() } = {}) {
  const accepted = report.accepted ?? [];
  const rejected = report.rejected ?? [];
  const attempts = report.attempts ?? [];
  const sourceErrors = attempts.flatMap((attempt) => (attempt.sources ?? []).filter((source) => source.status === 'error' || source.status === 'invalid_receipt').map((source) => ({ stage: attempt.stage, ...source })));
  return {
    schema_version: 1, status, started_at, finished_at, error: error ? String(error) : null,
    run_id: report.run_id ?? null, target: report.target ?? null, shortfall: report.shortfall ?? null, exhausted: Boolean(report.exhausted), stopped_by_budget: Boolean(report.stopped_by_budget),
    attempts, source_errors: sourceErrors, country_breakdown: countryCounts(accepted),
    counters: {
      discovered: attempts.reduce((total, attempt) => total + Number(attempt.discovered ?? 0), 0),
      processed: Number(report.processed ?? 0), evaluated: accepted.length + rejected.filter((entry) => !['already_processed', 'evaluation_disabled'].includes(entry.reason)).length,
      accepted: accepted.length, rejected_below_75: count(rejected, (reason) => reason === 'rejected_below_threshold'),
      rejected_eligibility_blocker: count(rejected, (reason) => reason === 'rejected_confirmed_eligibility_blocker'),
      rejected_closed_or_unverifiable: count(rejected, (reason) => /rejected_(closed|unverifiable)/.test(reason)),
      rejected_duplicates: count(rejected, (reason) => reason === 'already_processed'),
      sheet_written: sheetSync?.written?.length ?? 0, sheet_failed: sheetSync?.failed?.length ?? 0,
    },
    strongest: [...accepted].sort((a, b) => score(b) - score(a)).slice(0, 5).map((entry) => ({
      employer: entry.employer_legal_name ?? entry.company ?? 'Unknown', title: entry.title ?? 'Unknown', country: entry.country ?? 'Unknown', location: entry.location ?? 'Unknown', match_score: score(entry), application_url: entry.application_url ?? entry.url ?? null,
      technical_matches: entry.assessment?.evaluation?.technical_matches ?? [], technical_gaps: entry.assessment?.evaluation?.technical_gaps ?? [],
      immigration: entry.assessment?.verification?.immigration?.classification ?? entry.assessment?.evaluation?.immigration?.classification ?? 'unknown',
      immigration_evidence: entry.assessment?.verification?.immigration?.evidence ?? [], posting_date: entry.assessment?.verification?.posting_date ?? { value: entry.posting_date ?? null, status: entry.posting_date ? 'unverified' : 'unknown' },
    })),
    sheet_sync: sheetSync,
  };
}

export function renderDailyRunMarkdown(summary) {
  const lines = [`# Daily Discovery Report`, '', `- **Status:** ${summary.status}`, `- **Run:** ${summary.run_id ?? 'unknown'}`, `- **Finished:** ${summary.finished_at}`, `- **Shortfall:** ${summary.shortfall ?? 'unknown'}`, ''];
  if (summary.error) lines.push(`- **Error:** ${summary.error}`, '');
  lines.push('## Counters', '', `- Discovered: ${summary.counters.discovered}`, `- Processed: ${summary.counters.processed}`, `- Evaluated: ${summary.counters.evaluated}`, `- Accepted: ${summary.counters.accepted}`, `- Rejected below 75: ${summary.counters.rejected_below_75}`, `- Rejected by confirmed blocker: ${summary.counters.rejected_eligibility_blocker}`, `- Closed/unverifiable: ${summary.counters.rejected_closed_or_unverifiable}`, `- Duplicates: ${summary.counters.rejected_duplicates}`, `- Sheet writes: ${summary.counters.sheet_written}; failures: ${summary.counters.sheet_failed}`, '', '## Search stages');
  for (const attempt of summary.attempts) lines.push(`- ${attempt.number}. ${attempt.stage}: ${attempt.discovered} discovered${attempt.note ? ` — ${attempt.note}` : ''}`);
  lines.push('', '## Country breakdown');
  for (const [country, value] of Object.entries(summary.country_breakdown)) lines.push(`- ${country}: ${value}`);
  lines.push('', '## Strongest opportunities');
  if (!summary.strongest.length) lines.push('- None accepted.');
  for (const item of summary.strongest) {
    lines.push(`- **${item.match_score}/100 — ${item.title}, ${item.employer}** (${item.country}; ${item.location})`, `  - URL: ${item.application_url ?? 'unknown'}`, `  - Immigration: ${item.immigration}; posting date: ${item.posting_date?.value ?? 'unknown'} (${item.posting_date?.status ?? 'unknown'})`, `  - Matches: ${item.technical_matches.map((match) => match.requirement).join(', ') || 'none recorded'}`, `  - Gaps: ${item.technical_gaps.join(', ') || 'none recorded'}`);
  }
  if ((summary.shortfall ?? 0) > 0) lines.push('', '## Shortfall', '', `Only ${summary.counters.accepted} qualifying jobs were found; shortfall: ${summary.shortfall}. Attempted stages and source outcomes are listed above.`);
  return `${lines.join('\n')}\n`;
}

export function writeDailyRunReport(root, input, { now = new Date() } = {}) {
  if (!root) throw new TypeError('root is required');
  const summary = summarizeDailyRun(input);
  const dir = join(root, 'output', 'daily-runs', tunisDate(now));
  mkdirSync(dir, { recursive: true });
  const safeRunId = String(summary.run_id ?? now.toISOString()).replace(/[^a-zA-Z0-9_.-]/g, '-');
  const jsonPath = join(dir, `run-${safeRunId}.json`);
  const markdownPath = join(dir, `run-${safeRunId}.md`);
  atomicWrite(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  atomicWrite(markdownPath, renderDailyRunMarkdown(summary));
  return { summary, json_path: jsonPath, markdown_path: markdownPath };
}

export function dailyExitCode({ summary, error = null } = {}) {
  if (error) return /credential|config|yaml|GOOGLE_APPLICATION_CREDENTIALS|requires/i.test(String(error)) ? 2 : 1;
  if (summary?.counters?.sheet_failed > 0) return 5;
  if (summary?.attempts?.length && summary.attempts.every((attempt) => (attempt.sources ?? []).some((source) => source.status === 'error' || source.status === 'invalid_receipt'))) return 3;
  if (summary?.source_errors?.length) return 4;
  return 0; // A genuine market shortfall remains a successful, auditable run.
}
