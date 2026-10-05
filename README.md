# Chatbase YouTube Connector

[![CI](https://github.com/yel-hadd/chatbase-youtube-connector/actions/workflows/ci.yml/badge.svg)](https://github.com/yel-hadd/chatbase-youtube-connector/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Release](https://img.shields.io/github/v/release/yel-hadd/chatbase-youtube-connector)](https://github.com/yel-hadd/chatbase-youtube-connector/releases)

**Train a [Chatbase](https://link.chatbase.co/yassine-el-haddad) AI agent on your YouTube videos and keep it up to date every day, so it answers customers from your videos and links to the exact moment.**

> **Customer:** How do I hand a chat over to a human?
> **Agent:** Turn on the Chatbase live chat action, then … [watch at 0:24](https://youtu.be/tM3wpoieYTc?t=24)

Chatbase can train on files, websites, text, Q&A, Notion and tickets, but not YouTube. This connector fills that gap. It runs as a scheduled GitHub Action or as a Docker container on any server. It needs no database.

- **Timestamped answers.** Each video becomes one Chatbase source, split into sections of about one minute. Every section has a `?t=` link, and chapters from the video description become section headings.
- **Cheap.** New videos are found for free through YouTube's RSS feed and playlist pages. Transcripts come from the [YouTube Transcript Scraper Pro](https://apify.com/codepoetry/youtube-transcript-ai-scraper?fpr=use-apify) Actor on Apify, at about $1 per 1,000 videos. AI speech-to-text for videos without captions is optional and costs about 1¢ per minute. A day with no new uploads costs $0.
- **Safe by default.** A budget cap is checked before anything is spent. Deletions are off unless you turn them on, and capped per run. `--dry-run` shows the plan without spending or writing anything.
- **Works on every Chatbase plan.** On Standard and above it syncs through the Chatbase API. On Free and Hobby, which have no API access, it writes upload-ready files instead ([export mode](#chatbase-free-or-hobby-export-mode)).

## Before you start

You need three things:

| What                                        | Where to find it                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Apify API token** (`APIFY_TOKEN`)         | [Create a free Apify account](https://apify.com?fpr=use-apify), then go to **Settings → API & Integrations** ([Apify docs: API token](https://docs.apify.com/platform/integrations/api?fpr=use-apify)). Apify bills the transcripts to this account.                   |
| **Chatbase API key** (`CHATBASE_API_KEY`)   | Chatbase dashboard → **Workspace settings → API keys → Create API Key** ([Chatbase docs: API authentication](https://www.chatbase.co/docs/api-v2/authentication)). Needs the **Standard plan or higher**. On Free or Hobby, skip this and use [export mode](#chatbase-free-or-hobby-export-mode). |
| **Chatbase agent ID** (`CHATBASE_AGENT_ID`) | The ID in your agent's URL, also shown under the agent's **Settings → General → Agent details** ([Chatbase docs: agent settings](https://www.chatbase.co/docs/user-guides/chatbot/settings)). Not needed in export mode.                                                                                             |

Then pick where it runs:

| Setup                                                       | Pick it when                                                               | Needs                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------- |
| [GitHub Actions](#quick-start-github-actions) (recommended) | You want a daily sync with no server to look after                         | A GitHub repository         |
| [Docker on a server](#quick-start-docker-on-a-server)       | You already run a VPS, or your company does not use GitHub                 | Docker with Compose         |
| [Command line](#command-line)                               | You want to try it on your own computer, or run it from your own scheduler | Node.js 20 or newer and git |
| [Export mode](#chatbase-free-or-hobby-export-mode)          | Your Chatbase plan is Free or Hobby (no API access)                        | Any of the above            |

## Quick start: GitHub Actions

1. **Add a config file.** In a GitHub repository (a new private one is fine), create `chatbase-youtube.yaml`:

   ```yaml
   version: 1
   jobs:
     - name: academy
       agentId: ${CHATBASE_AGENT_ID}
       sources:
         - channel: '@YourChannel' # your channel handle, as in youtube.com/@YourChannel
   ```

   [`examples/chatbase-youtube.yaml`](examples/chatbase-youtube.yaml) is a fuller version with the most useful options.

2. **Add your credentials** under the repository's **Settings → Secrets and variables → Actions**:
   - on the **Secrets** tab: `APIFY_TOKEN` and `CHATBASE_API_KEY`;
   - on the **Variables** tab: `CHATBASE_AGENT_ID` (it is not secret).

3. **Add the workflow.** Copy [`examples/workflows/daily-sync.yml`](examples/workflows/daily-sync.yml) to `.github/workflows/chatbase-youtube.yml` and commit it. Then open the **Actions** tab, choose **Sync YouTube to Chatbase → Run workflow**:
   - first with **Plan only** ticked, to see what would happen;
   - then with **Full re-check** ticked, to load every existing video;
   - after that it runs by itself: new videos daily, a full re-check every Sunday.

Each run's summary appears on the run page, and `report.json` is attached as an artifact. Finish by [telling the agent to cite timestamps](#make-the-agent-cite-timestamps).

> **Why a full run first?** The daily run only looks at a channel's newest 15 videos (the RSS feed, which is free). A full run lists every upload through Apify, so use it once to load your back catalogue.

## Quick start: Docker on a server

```bash
mkdir -p chatbase-youtube/data && cd chatbase-youtube
sudo chown 1000:1000 data   # the container runs as uid 1000 and writes its reports and state here
curl -O https://raw.githubusercontent.com/yel-hadd/chatbase-youtube-connector/main/docker-compose.yml
curl -o chatbase-youtube.yaml https://raw.githubusercontent.com/yel-hadd/chatbase-youtube-connector/main/examples/chatbase-youtube.yaml
# edit chatbase-youtube.yaml: put your channel under sources:
printf 'APIFY_TOKEN=...\nCHATBASE_API_KEY=...\nCHATBASE_AGENT_ID=...\n' > .env && chmod 600 .env   # then put your real values in .env

docker compose run --rm chatbase-youtube-sync doctor               # checks keys, plan, agent, channel; spends nothing
docker compose run --rm chatbase-youtube-sync sync --dry-run       # shows the plan
docker compose run --rm chatbase-youtube-sync sync --full          # one-off: loads every existing video
docker compose up -d                                               # then: daily sync + weekly full re-check
```

Arguments after the service name go straight to the CLI, so every [command](#command-line) works this way. The `data` folder holds `report.json`, the skip cache (`.chatbase-youtube/`) and, in export mode, the files to upload (`out/`).

| Variable (in `.env` or `docker-compose.yml`) | Effect                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `SCHEDULE`                                   | Cron schedule for the normal sync. Default `17 6 * * *` (daily, 06:17 UTC)               |
| `FULL_SCHEDULE`                              | Cron schedule for the full re-check. Default `43 4 * * 0` (Sundays)                      |
| `HEALTHCHECK_URL`                            | Pinged on start (`/start`), success, and failure (`/<exit code>`), healthchecks.io style |
| `REPORT_WEBHOOK_URL`                         | Receives `report.json` as a JSON POST after every scheduled run                          |
| `CONFIG`                                     | Config path inside the container. Default `/config/chatbase-youtube.yaml`                |

The container runs as a non-root user with a read-only filesystem. To use systemd instead of the built-in scheduler, the unit files are in [`deploy/`](deploy).

## Chatbase Free or Hobby: export mode

Without API access, the connector writes one text file per video, and you upload them in the Chatbase dashboard.

1. In your config, set `sink: export` and delete the `agentId` line (or the run will ask for `CHATBASE_AGENT_ID`):

   ```yaml
   version: 1
   jobs:
     - name: academy
       sink: export
       sources:
         - channel: '@YourChannel'
   ```

2. Run it with only `APIFY_TOKEN` set. [`examples/workflows/export-free-plan.yml`](examples/workflows/export-free-plan.yml) does this weekly on GitHub Actions and commits the files to your repository.
3. Open `out/<job name>/CHANGES.txt`. It lists exactly which files to upload (or replace) and which to delete under **Sources → Files** in Chatbase.

What is in `out/<job name>/`:

- `<videoId>.txt`, one per video (very long videos get `<videoId>.p2.txt` and so on);
- `CHANGES.txt`, the changes from the **latest run only**. Upload after every run, or look at its history in git;
- `manifest.json`, which records what was exported. Keep it: without it, the next run rebuilds and pays for every video again.

## Command line

Requires Node.js 20 or newer and git. npm downloads and builds the tool from GitHub the first time:

```bash
npx github:yel-hadd/chatbase-youtube-connector init            # write a starter chatbase-youtube.yaml
npx github:yel-hadd/chatbase-youtube-connector doctor          # check keys, plan, agent and channels; spends nothing
npx github:yel-hadd/chatbase-youtube-connector sync --dry-run  # show the plan
```

Or clone it once and run it directly:

```bash
git clone https://github.com/yel-hadd/chatbase-youtube-connector && cd chatbase-youtube-connector
npm ci                                   # also builds dist/
node dist/cli.js -c /path/to/chatbase-youtube.yaml doctor
```

Credentials are read from environment variables only (`export APIFY_TOKEN=...` and so on).

| Command                    | What it does                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `init`                     | Writes a starter `chatbase-youtube.yaml` (refuses to overwrite one)                                             |
| `validate`                 | Checks the config and prints it with every default filled in                                                    |
| `doctor`                   | Checks the Apify token, the Chatbase key, plan and agent, and each channel. Spends nothing                      |
| `sync`                     | Adds new videos                                                                                                 |
| `sync --full`              | Lists every video: adds missing ones, updates changed transcripts and, with `prune: true`, removes deleted ones |
| `sync --dry-run`           | Shows what `sync` would do. No Apify spend, no writes (it still reads your Chatbase agent)                      |
| `sync --job <name>`        | Runs one job from the config (`doctor --job` works too)                                                         |
| `sync --allow-mass-delete` | Allows more deletions than `budget.maxDeletesPerRun`                                                            |
| `sync --report <path>`     | Where to write the JSON report. Default `report.json`                                                           |

Global options go before the command: `-c <path>` for the config file (default `chatbase-youtube.yaml`), `--pretty` for readable logs instead of JSON lines, `--log-level debug|info|warn|error`.

Every `sync` writes `report.json`: counts, each video's outcome, estimated and actual spend, and storage used before and after. In GitHub Actions the same summary appears on the run page.

## Choose which videos go in

Only what you list under `sources` is synced. Mix channels, playlists and single videos, and keep things out with `exclude` and `filters`:

```yaml
version: 1
jobs:
  - name: academy
    agentId: ${CHATBASE_AGENT_ID}
    sources:
      - channel: '@AcmeAcademy' # a whole channel
      - playlist: 'PLxxxxxxxxxxxxxxxx' # or only some playlists
      - video: 'https://youtu.be/xxxxxxxxxxx' # or single videos
    exclude: # keep these out, even if a source includes them
      - 'https://youtu.be/yyyyyyyyyyy'
      - 'PLzzzzzzzzzzzzzzzz' # every video in this playlist
    filters:
      titleExclude: ['(?i)teaser|trailer']
      publishedAfter: '2024-01-01'
    prune: true # also remove excluded or deleted videos already in the agent
```

Every option is in [docs/configuration.md](docs/configuration.md). One config can hold several jobs, one per agent.

## How it works

```
YouTube RSS / playlist page ─► Apify transcript Actor ─► timestamped Markdown ─► diff vs Chatbase ─► create / update / delete text sources
```

| Run                    | Finds videos through                                                    | What it does                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `sync` (daily)         | Free: channel RSS feed (newest 15), playlists in full                   | Transcribes and adds videos the agent does not have yet                                                            |
| `sync --full` (weekly) | Every upload, including Shorts and live recordings, listed by the Actor | Also adds missing videos, updates changed transcripts and, with `prune: true`, removes videos deleted from YouTube |

The connector keeps its sync state in the Chatbase source names (`YT·<videoId>·<hash>·<title>`), so it needs no database and a re-run with nothing new makes no writes. It only ever touches sources whose names start with `YT·`; your other sources are left alone. A small skip cache remembers videos with no captions, so they are not paid for again every day. It stays under Chatbase's API rate limit and retries when Chatbase is busy.

## Make the agent cite timestamps

Each video source starts with a heading ending in "(video)", and every section has a `[watch](…)` link. Add this to your agent's instructions in Chatbase:

> When an answer comes from a video source (its heading ends in "(video)"), include the matching `[watch](…)` link from that section so the customer can jump to the moment. If no source covers the question, reply exactly: "I couldn't find this in our videos."

## Costs

| Scenario                                                | Apify cost                                   |
| ------------------------------------------------------- | -------------------------------------------- |
| Daily run, no new videos                                | $0 (free discovery, skip cache)              |
| 1 new video with captions                               | ≈ $0.001                                     |
| Backfill 300 videos × 20 min, 20% without captions (AI) | 300 × $0.001 + 60 × 20 × $0.012 ≈ **$14.70** |

Before each Apify run, the connector works out the worst case (every video charged, plus the full `aiFallback.maxMinutesPerRun` if AI is on) and stops if that is over `budget.maxUsdPerRun` (default $5). The backfill above needs a higher budget and AI cap.

Storage: an hour of speech is roughly 55–65 KB of text. Chatbase plans allow 1, 10, 20 or 40 MB of training content (Free, Hobby, Standard, Pro). Set `budget.storageLimitMb` and the run stops adding videos before it would go over.

## Troubleshooting

Start with `doctor`: it checks each credential and channel and spends nothing. Every run ends with an exit code. The error is in the log and, for a `sync` that got as far as starting a job, in `report.json`.

| Exit code | Meaning                                                                      |
| --------- | ---------------------------------------------------------------------------- |
| 0         | Success                                                                      |
| 1         | Unexpected error (for example an Apify run failed or timed out)              |
| 2         | Config problem                                                               |
| 3         | A budget, storage or delete cap stopped the run, or part of it               |
| 4         | Partial failure: some videos failed, the rest are synced                     |
| 5         | A credential is missing or rejected, or your Chatbase plan has no API access |

| Message                                                                          | Exit | Fix                                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `environment variable CHATBASE_AGENT_ID is referenced in the config but not set` | 2    | Set that variable. On GitHub, the example workflow reads `CHATBASE_AGENT_ID` from **Variables**, not Secrets. In export mode, delete the `agentId` line.                                         |
| `config is invalid:` followed by a list                                          | 2    | Each line names the key and the problem. Unknown keys are rejected, so check spelling against [docs/configuration.md](docs/configuration.md).                                                    |
| `cannot read config file …`                                                      | 2    | Wrong path. Pass `-c <path>`; in Docker the file must be mounted at `/config/chatbase-youtube.yaml`.                                                                                             |
| `could not resolve YouTube channel "…"`                                          | 2    | Use the channel's `UC…` ID or its full URL instead of the handle.                                                                                                                                |
| `Chatbase agent "…" was not found. Check agentId.`                               | 2    | Check the agent ID, and that the API key comes from the workspace that owns the agent.                                                                                                           |
| `Chatbase API v2 needs the Standard plan or higher…`                             | 5    | Upgrade, or use [export mode](#chatbase-free-or-hobby-export-mode).                                                                                                                              |
| `CHATBASE_API_KEY is not set` / `Chatbase rejected the API key (401)`            | 5    | Set or replace `CHATBASE_API_KEY`.                                                                                                                                                               |
| `APIFY_TOKEN is not set`                                                         | 5    | Set `APIFY_TOKEN`.                                                                                                                                                                               |
| `Apify rejected the token (HTTP 401)`                                            | 5    | The Apify token is wrong or revoked. Copy it again from Apify **Settings → API & Integrations**.                                                                                                 |
| `worst-case spend $… is over budget.maxUsdPerRun`                                | 3    | Nothing was spent. Raise `budget.maxUsdPerRun`, or lower `aiFallback.maxMinutesPerRun`, `budget.maxNewVideosPerRun` or (full runs) `maxVideos`.                                                  |
| `… would be deleted, over budget.maxDeletesPerRun` / `removals … were held back` | 3    | Check the report. If the deletions are intended, re-run with `--allow-mass-delete` (Action input `allow-mass-delete: true`).                                                                     |
| `storage limit reached; remaining videos were not synced`                        | 3    | The agent is full. Remove sources, upgrade, or narrow `sources` and `filters`. The rest are added once there is room.                                                                            |
| `a source listing failed and was skipped`                                        | 4    | Usually temporary. The other sources were synced; pruning was skipped for safety. The next run retries.                                                                                          |
| Videos with `failed` in the report                                               | 4    | The detail column has the reason. Failed videos are retried on the next run.                                                                                                                     |
| Warning `playlist listing is incomplete; set YOUTUBE_API_KEY`                    | 0    | Without a key, only the first 100 videos of a playlist are read. Set `YOUTUBE_API_KEY`, a free YouTube Data API v3 key ([Google docs: get an API key](https://developers.google.com/youtube/registering_an_application)).                                                                         |
| Warning `listing hit maxVideos; prune is skipped this run`                       | 0    | The channel has more videos than `maxVideos` (default 500). Raise it so full runs see everything.                                                                                                |
| Videos `skipped` with `NO_CAPTIONS_AVAILABLE`                                    | 0    | The video has no captions. Turn on `aiFallback.enabled`. Skipped videos are re-checked after `recheckSkippedAfterDays` (30), or on the next run if you change the transcript or filter settings. |
| Old videos never appear                                                          | 0    | The daily run only sees a channel's newest 15 uploads. Run `sync --full` once.                                                                                                                   |
| Docker: `EACCES` / permission denied under `/data`                               | 1    | Run `sudo chown 1000:1000 data` in the folder that holds `docker-compose.yml`.                                                                                                                   |
| GitHub: the schedule stopped running                                             | –    | Scheduled workflows run only from the default branch, and GitHub pauses them in public repositories after 60 days without activity. Re-enable it in the Actions tab.                             |

For more detail, run with `--log-level debug --pretty`.

## Security

- Secrets come only from environment variables. Logs mask tokens.
- No telemetry: data flows only between YouTube, Apify and your Chatbase workspace.
- Use it for your own channel or content you have rights to. Only public and unlisted videos are processed.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

MIT licensed. Built by [use-apify.com](https://use-apify.com). Step-by-step tutorial: [Connect a YouTube channel to Chatbase](https://use-apify.com/blog/chatbase-youtube-connector).
