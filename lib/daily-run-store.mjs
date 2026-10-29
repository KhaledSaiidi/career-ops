import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = () => ({ version: 1, processed: {}, runs: {} });

export function readDailyRunStore(filePath) {
  if (!existsSync(filePath)) return EMPTY();
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    return value?.version === 1 && value.processed && value.runs ? value : EMPTY();
  } catch { return EMPTY(); }
}

export function writeDailyRunStore(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temporary, filePath);
}

export function hasProcessed(state, fingerprint) { return Boolean(state?.processed?.[fingerprint]); }

export function markProcessed(state, fingerprint, record) {
  state.processed[fingerprint] = record;
  return state;
}
