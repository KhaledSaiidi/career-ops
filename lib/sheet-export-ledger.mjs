import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { withPipelineLock } from '../pipeline-lock.mjs';

export function readExportLedger(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`Export ledger is corrupt at line ${index + 1}; refusing to risk a duplicate append`); }
    if (!event?.dedup_key || !event?.event) throw new Error(`Export ledger has an invalid event at line ${index + 1}`);
    return event;
  });
}

export function latestExportEvents(events) {
  const latest = new Map();
  for (const event of events) latest.set(event.dedup_key, event);
  return latest;
}

export async function appendExportLedgerEvent(filePath, event) {
  if (!event?.dedup_key || !event?.event) throw new TypeError('ledger event requires dedup_key and event');
  return withPipelineLock(filePath, async () => {
    mkdirSync(dirname(filePath), { recursive: true });
    const record = { at: new Date().toISOString(), ...event };
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  });
}
