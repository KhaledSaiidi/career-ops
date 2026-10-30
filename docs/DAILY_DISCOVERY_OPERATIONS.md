# Daily Discovery Operations

The daily command is `node daily-discovery.mjs`. It only discovers, evaluates, verifies, deduplicates, reports, and—when explicitly enabled—appends recommendations. It never opens or submits applications.

## Safety gates

Before enabling the timer, confirm all of the following:

1. `codex login status` shows the intended ChatGPT-authenticated CLI account.
2. The service-account JSON exists locally, is ignored by Git, and is mode `600`.
3. `config/daily-discovery.yml` has the intended country weights, `sheets` ID/tab, and `discovery.write_google_sheet: true` only when live appends are approved.
4. The Sheet headers remain `Recommended Jobs!A1:M1` exactly as configured.

The exporter refuses schema drift, writes only `Recommended Jobs!B:M`, and records an append-only local receipt ledger before and after every export attempt.

## Manual validation

Start with a verification-only scan:

```bash
npm run daily:discovery -- --live-scan --source portals --max-stages 1
```

Then use a bounded evaluated run (Codex usage applies):

```bash
npm run daily:discovery -- --live-scan --source portals --max-stages 1 --evaluate --persist-state
```

Only after reviewing reports, enable `write_google_sheet: true` and make one controlled run with `--write-sheet`. Every run writes JSON and Markdown evidence under `output/daily-runs/<Tunisia-date>/`.

## Install the user timer

No unit is installed by this repository. To install after the controlled run succeeds:

```bash
mkdir -p ~/.config/systemd/user ~/.config/career-ops
cp ops/systemd/career-ops-daily.service ~/.config/systemd/user/
cp ops/systemd/career-ops-daily.timer ~/.config/systemd/user/
cp ops/systemd/career-ops.env.example ~/.config/career-ops/daily.env
chmod 600 ~/.config/career-ops/daily.env
systemctl --user daemon-reload
systemctl --user enable --now career-ops-daily.timer
systemctl --user list-timers career-ops-daily.timer
```

The timer runs at 18:00 `Africa/Tunis`; `Persistent=true` schedules a missed run after the computer resumes. It cannot execute at the original wall-clock time while the laptop is off. `flock` prevents overlap; the skipped contender exits 75 and is treated as successful by systemd. Codex evaluation is bounded to 120 seconds per vacancy by default; tune `CODEX_EVALUATOR_TIMEOUT_MS` only after a successful controlled run.

For execution while the laptop is often off, move the same checkout/data root and credential setup to an always-on Ubuntu VM. Do not introduce containers or Kubernetes merely for this timer.

## Logs, reports, and recovery

```bash
systemctl --user status career-ops-daily.service
journalctl --user -u career-ops-daily.service --since today
systemctl --user start career-ops-daily.service
```

Exit codes: `0` completed (including an honest market shortfall), `1` unexpected failure, `2` configuration/credential failure, `3` no source reachable, `4` partial source failure, `5` Sheet export failure. Reports are written for successful, partial, and failed attempts.

If an append response is lost, do not rerun the API manually. The exporter reads the Sheet by dedup key before any later append and keeps pending records plus `data/daily-discovery-export-ledger.jsonl`. Disable the timer first if investigation is needed; preserve reports and ledgers rather than deleting them.
