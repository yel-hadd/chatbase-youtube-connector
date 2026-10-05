# Chatbase YouTube Connector

[![CI](https://github.com/yel-hadd/chatbase-youtube-connector/actions/workflows/ci.yml/badge.svg)](https://github.com/yel-hadd/chatbase-youtube-connector/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Release](https://img.shields.io/github/v/release/yel-hadd/chatbase-youtube-connector)](https://github.com/yel-hadd/chatbase-youtube-connector/releases)

Keep a [Chatbase](https://link.chatbase.co/yassine-el-haddad) AI agent trained on your YouTube channel, so it answers customers from your videos and links to the exact moment:

> **Customer:** How do I hand a chat over to a human?
> **Agent:** Turn on the Chatbase live chat action, then … [watch at 0:24](https://youtu.be/tM3wpoieYTc?t=24)

Chatbase can train on files, websites, text, Q&A, Notion and tickets, but not YouTube. This connector fills that gap. It runs as a **scheduled GitHub Action** or a **Docker container on any VPS**. There is no server to host and no database.

- **Timestamped knowledge.** Every video becomes one Chatbase source, split into sections of about one minute, each with a `?t=` link. Chapters from the video description become section headings.
- **Incremental and cheap.** New videos are found for free (YouTube's RSS feed for channels, the playlist page for playlists). Videos without captions or too short to keep are remembered in a small skip cache, so a day with no uploads costs $0. Transcripts come from the [YouTube Transcript Scraper Pro](https://apify.com/codepoetry/youtube-transcript-ai-scraper?fpr=use-apify) Actor on Apify: about $1 per 1,000 videos, with optional AI speech-to-text (≈1¢/min) for videos without captions.
- **Stateless and idempotent.** Sync state lives in the Chatbase source names (`YT·<videoId>·<hash>·<title>`). A re-run with nothing new makes zero writes. Runners can be thrown away.
- **Safe by default.**
  - A budget guard aborts before any spend that would exceed your cap.
  - Deletions are opt-in and capped per run.
  - `--dry-run` shows the plan without spending or writing anything.
  - The connector respects Chatbase's rate limit (100 req/10 s) and handles `409`/`429` responses.
- **Works on every Chatbase plan.** On Standard and above it syncs through the Chatbase API. On Free and Hobby (no API access) it exports ready-to-upload files instead.

## How it works

```
YouTube RSS / channel listing ─► Apify transcript Actor ─► format (timestamped Markdown) ─► diff vs Chatbase ─► create / update / delete text sources
```

| Run                    | Discovery                                                     | What it does                                                                                  |
| ---------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `sync` (daily)         | Free: channel RSS (newest 15), playlists in full              | Transcribes and adds videos you don't have yet                                                |
| `sync --full` (weekly) | Every upload (incl. Shorts and live recordings) via the Actor | Also updates changed transcripts and, with `prune: true`, removes videos deleted from YouTube |

## Choose exactly which videos go in

```yaml
jobs:
  - name: academy
    agentId: ${CHATBASE_AGENT_ID}
    sources: # only what you list is synced
      - channel: '@AcmeAcademy' # a whole channel…
      - playlist: 'PLxxxxxxxx' # …or just some playlists
      - video: 'https://youtu.be/xxxxxxxxxxx' # …or single videos
    exclude: # keep these out, even if a source includes them
      - 'https://youtu.be/yyyyyyyyyyy'
      - 'PLzzzzzzzz' # every video in this playlist
    filters:
      titleExclude: ['(?i)teaser|trailer']
      publishedAfter: '2024-01-01'
    prune: true # also remove excluded or deleted videos already in the agent
```

Every option is documented in [docs/configuration.md](docs/configuration.md).

## Quick start: GitHub Actions

1. Add a config file `chatbase-youtube.yaml` to a repository (see [`examples/chatbase-youtube.yaml`](examples/chatbase-youtube.yaml)):
   ```yaml
   version: 1
   jobs:
     - name: academy
       agentId: ${CHATBASE_AGENT_ID}
       sources:
         - channel: '@YourChannel'
   ```
2. Add secrets in **Settings → Secrets and variables → Actions**:
   - secret `APIFY_TOKEN`: [get a free Apify account](https://apify.com?fpr=use-apify), then Settings → API & Integrations;
   - secret `CHATBASE_API_KEY`: Chatbase → Workspace settings → API keys (Standard plan or higher);
   - variable `CHATBASE_AGENT_ID`: the ID in your agent's URL.
3. Copy [`examples/workflows/daily-sync.yml`](examples/workflows/daily-sync.yml) to `.github/workflows/`. Run it once from the Actions tab with **dry-run** ticked, then without.

## Quick start: VPS (Docker)

```bash
mkdir -p chatbase-youtube/data && cd chatbase-youtube
sudo chown 1000:1000 data   # the container runs as an unprivileged user (uid 1000)
curl -O https://raw.githubusercontent.com/yel-hadd/chatbase-youtube-connector/main/docker-compose.yml
curl -o chatbase-youtube.yaml https://raw.githubusercontent.com/yel-hadd/chatbase-youtube-connector/main/examples/chatbase-youtube.yaml
printf 'APIFY_TOKEN=...\nCHATBASE_API_KEY=...\nCHATBASE_AGENT_ID=...\n' > .env && chmod 600 .env
docker compose run --rm chatbase-youtube-sync doctor          # check everything, spend nothing
docker compose run --rm chatbase-youtube-sync sync --dry-run  # see the plan
docker compose up -d                                          # daily sync + weekly full re-check
```

The container runs as a non-root user with a read-only filesystem. You can override the schedule with `SCHEDULE` and `FULL_SCHEDULE` (cron syntax). If you set `HEALTHCHECK_URL`, it pings that URL on start, success and failure (healthchecks.io style), and `REPORT_WEBHOOK_URL` receives `report.json` after each run. If you'd rather use systemd than the built-in scheduler, unit files are in [`deploy/`](deploy).

## CLI

```bash
npx github:yel-hadd/chatbase-youtube-connector init                 # starter config
npx github:yel-hadd/chatbase-youtube-connector doctor               # tokens, plan access, agent, channels; no spend
npx github:yel-hadd/chatbase-youtube-connector sync --dry-run
npx github:yel-hadd/chatbase-youtube-connector sync                 # new videos
npx github:yel-hadd/chatbase-youtube-connector sync --full          # re-check everything
npx github:yel-hadd/chatbase-youtube-connector validate             # print the resolved config
```

| Exit code | Meaning                                                                        |
| --------- | ------------------------------------------------------------------------------ |
| 0         | Success                                                                        |
| 1         | Unexpected error (e.g. an Apify run failed or timed out)                       |
| 2         | Config invalid                                                                 |
| 3         | A budget, storage or delete cap stopped the run or part of it (see the report) |
| 4         | Partial failure (some videos failed; the rest are synced)                      |
| 5         | Auth or plan problem (e.g. Chatbase API needs Standard)                        |

Each run writes `report.json`, which lists counts, every video's outcome, estimated and actual spend, and storage before and after. In GitHub Actions the same summary appears on the run page.

## Chatbase Free or Hobby: export mode

The Chatbase API needs the Standard plan. On Free and Hobby, set `sink: export`. The connector writes one `.txt` per video plus `CHANGES.txt`, which lists exactly which files to upload or delete under **Sources → Files**. Re-runs only rebuild changed videos. [`examples/workflows/export-free-plan.yml`](examples/workflows/export-free-plan.yml) runs this weekly and gives you the files as a workflow artifact.

## Make the agent cite timestamps

Add this to your agent's instructions in Chatbase:

> When an answer comes from a video source (titles ending in "(video)"), include the matching `[watch](…)` link from that section so the customer can jump to the moment. If no source covers the question, reply exactly: "I couldn't find this in our videos."

## Costs, worked through

| Scenario                                                | Apify cost                                   |
| ------------------------------------------------------- | -------------------------------------------- |
| Daily run, no new videos                                | $0 (free discovery, skip cache)              |
| 1 new video with captions                               | ≈ $0.001                                     |
| Backfill 300 videos × 20 min, 20% without captions (AI) | 300 × $0.001 + 60 × 20 × $0.012 ≈ **$14.70** |

Storage: an hour of speech is roughly 55–65 KB of text. Chatbase plans allow 1, 10, 20 or 40 MB of training content (Free, Hobby, Standard, Pro). Set `budget.storageLimitMb` and the run stops before it would go over.

## Security

- Secrets come only from environment variables. Logs redact tokens.
- No telemetry: data flows only between YouTube, Apify and your Chatbase workspace.
- Use it for your own channel or content you have rights to. Only public and unlisted videos are processed.

## Development

```bash
npm ci && npm test && npm run build
```

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

MIT licensed. Built by [use-apify.com](https://use-apify.com). Step-by-step tutorial: [Connect a YouTube channel to Chatbase](https://use-apify.com/blog/chatbase-youtube-connector).
