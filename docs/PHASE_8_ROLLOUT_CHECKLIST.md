# Phase 8 Controlled Rollout Checklist

Run this checklist in order. Do not treat the five-job target as a reason to weaken scoring, liveness, authenticity, or eligibility gates.

## 1. Local deterministic validation

- [ ] `node test-all.mjs --only daily-discovery-e2e`
- [ ] `node test-all.mjs --only daily-report`
- [ ] `node test-all.mjs --only recommended-jobs-sync`
- [ ] `npm run daily:systemd:verify`
- [ ] `npm run lint`

## 2. Read-only external checks

- [ ] Confirm `codex login status` is authenticated as the intended ChatGPT account.
- [ ] Confirm the service-account JSON is mode `600`, ignored by Git, and shared with the target Sheet.
- [ ] Run a bounded live scan without `--evaluate`, `--persist-state`, or `--write-sheet`.
- [ ] Confirm `Recommended Jobs!A1:M1` still matches the required schema and `Search Rules` remains untouched.

## 3. Bounded evaluated dry run

- [ ] Run one stage only: `npm run daily:discovery -- --live-scan --source portals --max-stages 1 --evaluate --persist-state`.
- [ ] Review the generated JSON/Markdown report under `output/daily-runs/`.
- [ ] Check accepted records for score evidence, confirmed-blocker handling, liveness, application URL, posting-date uncertainty, and immigration classification.
- [ ] Confirm no applications were opened or submitted.
- [ ] Keep `discovery.write_google_sheet: false` during this step.

## 4. One controlled export

- [ ] Review the exact accepted records in the report.
- [ ] Set `discovery.write_google_sheet: true` only for the controlled export.
- [ ] Run with `--persist-state --write-sheet`; verify the ledger and Sheet readback report.
- [ ] Confirm only B:M changed for new rows; column A and historical rows remain untouched.
- [ ] Re-run the same command only if recovery is required; verify it reports duplicates rather than appending again.

## 5. Scheduling sign-off

- [ ] Confirm source coverage and cost are acceptable after several dry-run days.
- [ ] Install and enable the user timer using `docs/DAILY_DISCOVERY_OPERATIONS.md`.
- [ ] Verify the scheduled command, next trigger time, journald logs, and one manually started service run.
- [ ] Keep the local report directory, state file, and export ledger backed up.

## Rollback

```bash
systemctl --user disable --now career-ops-daily.timer
```

Do not delete `data/daily-discovery-state.json`, `data/daily-discovery-export-ledger.jsonl`, or run reports. They are required to diagnose and safely resume an interrupted export.
