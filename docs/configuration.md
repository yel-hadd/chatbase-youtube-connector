# Configuration reference

The connector reads `chatbase-youtube.yaml` from the current folder (use `-c <path>` for another file). Run `chatbase-youtube-sync validate` (or `node dist/cli.js validate`) to check a config and print it with every default filled in.

## A complete example

Every key below is optional except `version`, `jobs`, and each job's `name` and `sources` (plus `agentId` when `sink` is `rest`). The values shown are the defaults unless a comment says otherwise.

```yaml
version: 1 # required, always 1

defaults: # applied to every job; a job can override any of these
  # Which videos
  includeShorts: false # skip YouTube Shorts
  minDurationSec: 60 # skip videos shorter than this
  filters:
    titleInclude: [] # only titles matching one of these regexes
    titleExclude: [] # drop titles matching any of these, e.g. ['(?i)teaser|trailer']
    # publishedAfter: '2024-01-01'   # skip older videos
  exclude: [] # videos or playlists to keep out, by URL or ID

  # Transcripts
  languages: [en] # caption languages, in order of preference
  machineTranslate: true # translate captions from another language, keeping timestamps
  aiFallback:
    enabled: false # AI speech-to-text for videos without captions (billed per minute)
    maxMinutesPerRun: 60
    skipLongerThanMin: 90
    # language: en                    # force the transcription language (default: auto-detect)
  actorId: codepoetry/youtube-transcript-ai-scraper
  # actorBuild: '2.8.3'               # pin an Actor build (default: latest)

  # Output
  segmentSeconds: 60 # length of each timestamped section (15–600)
  sink: rest # rest = Chatbase API (Standard plan+), export = files for manual upload
  exportDir: out # export mode writes to <exportDir>/<job name>/

  # Full runs and removal
  maxVideos: 500 # how many videos a --full run lists per channel or playlist
  prune: false # remove videos deleted from YouTube or excluded in config

  # State
  stateDir: .chatbase-youtube # skip cache, one file per job
  recheckSkippedAfterDays: 30

  # Safety
  budget:
    maxUsdPerRun: 5
    maxNewVideosPerRun: 200
    maxDeletesPerRun: 10
    # storageLimitMb: 20              # your Chatbase plan's training limit (default: no limit)
  pricing:
    transcriptUsd: 0.001
    aiMinuteUsd: 0.012

jobs: # one job = one Chatbase agent (or one export folder)
  - name: academy # required: lowercase letters, digits and dashes, unique
    agentId: ${CHATBASE_AGENT_ID} # required when sink is rest
    sources: # required, at least one
      - channel: '@AcmeAcademy'
```

## How the file is read

- **Environment variables.** `${VAR}` is replaced with the value of the environment variable `VAR` (uppercase letters, digits and `_`). An unset or empty variable stops the run with an error, rather than becoming an empty string. Only values are replaced, so a commented-out line never needs its variable.
- **Strict keys.** Unknown keys are rejected, so a typo fails straight away instead of being ignored.
- **Defaults and jobs.** A job inherits every key from `defaults`. The nested objects `budget`, `filters`, `aiFallback` and `pricing` merge one level deep, so a job can change one field and keep the rest. `exclude` lists are added together: the default exclusions plus the job's own.

## Jobs

| Key       | Default | Effect                                                                                                                   |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `name`    | —       | Required. Lowercase letters, digits and dashes, up to 63 characters, unique. Used for `--job`, file names and the report |
| `agentId` | none    | Required when `sink` is `rest`: the ID in your agent's URL in the Chatbase dashboard                                     |
| `sources` | —       | Required. What to sync (below)                                                                                           |

## Choosing videos

### What to sync: `sources`

`sources` is the allow-list: only what you list is synced. Mix any of the three kinds.

```yaml
sources:
  - channel: '@AcmeAcademy' # every video on the channel (handle, channel URL or UC… ID)
  - playlist: 'PLxxxxxxxxxxxxxxxx' # only this playlist (URL or ID)
  - video: 'https://youtu.be/xxxxxxxxxxx' # one video (URL or ID)
```

To sync only a few videos, list them as `video:` entries and leave out the channel. To sync only a few playlists, list those playlists.

### What to keep out: `exclude`

```yaml
exclude:
  - 'https://www.youtube.com/watch?v=xxxxxxxxxxx' # one video
  - 'PLyyyyyyyyyyyyyyyy' # every video in this playlist
```

- An excluded video is never transcribed, so it costs nothing.
- If an excluded video is already in the agent, the run report flags it. With `prune: true`, the next run removes it. This counts towards `budget.maxDeletesPerRun`.
- Excluded playlists are listed in full on every run. Without `YOUTUBE_API_KEY` the connector reads the public playlist page, which shows the first 100 videos. For bigger playlists the run warns, and you should set `YOUTUBE_API_KEY`, a free YouTube Data API v3 key ([how to create one](https://developers.google.com/youtube/registering_an_application)).

### Rules: `filters`, `includeShorts`, `minDurationSec`

| Key                      | Default | Effect                                                                       |
| ------------------------ | ------- | ---------------------------------------------------------------------------- |
| `filters.titleInclude`   | `[]`    | Only titles matching one of these regexes (`(?i)` prefix = case-insensitive) |
| `filters.titleExclude`   | `[]`    | Drop titles matching any of these                                            |
| `filters.publishedAfter` | none    | `YYYY-MM-DD`; older videos are skipped                                       |
| `includeShorts`          | `false` | YouTube Shorts (and titles tagged `#shorts`) are skipped unless `true`       |
| `minDurationSec`         | `60`    | Skip videos shorter than this                                                |

Rules apply to new videos only. A video already in the agent is never deleted because of a rule, only through `exclude` + `prune` or because it was removed from YouTube.

A channel's RSS feed carries titles, dates and the Shorts flag, so those rules are applied before anything is paid for. Durations, and the titles of videos found through playlists or `video:` entries, are only known after the transcript is fetched. A video dropped at that point costs one transcript, then the [skip cache](#state-between-runs) remembers it.

## Transcripts

| Key                            | Default                                    | Effect                                                                                |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `languages`                    | `[en]`                                     | Caption language codes, in order of preference                                        |
| `machineTranslate`             | `true`                                     | Translate captions from another language into your first language, keeping timestamps |
| `aiFallback.enabled`           | `false`                                    | AI speech-to-text for videos without captions (billed per minute)                     |
| `aiFallback.maxMinutesPerRun`  | `60`                                       | Hard cap on AI minutes per Apify run                                                  |
| `aiFallback.skipLongerThanMin` | `90`                                       | Don't AI-transcribe videos longer than this many minutes                              |
| `aiFallback.language`          | auto-detect                                | Force the AI transcription language                                                   |
| `actorId`                      | `codepoetry/youtube-transcript-ai-scraper` | The Apify Actor that fetches transcripts                                              |
| `actorBuild`                   | latest                                     | Pin an Actor build (e.g. `2.8.3`) for reproducible output                             |

## Output

| Key              | Default | Effect                                                                                                       |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `segmentSeconds` | `60`    | Target length of each timestamped section, 15–600. Sections end on a sentence                                |
| `sink`           | `rest`  | `rest` writes to Chatbase through the API (Standard plan or higher). `export` writes files for manual upload |
| `exportDir`      | `out`   | Where `sink: export` writes, one folder per job (`out/<job name>/`)                                          |

Changing `segmentSeconds` changes every formatted transcript, so the next run updates every source once.

## Full runs and removal

| Key         | Default | Effect                                                                                     |
| ----------- | ------- | ------------------------------------------------------------------------------------------ |
| `maxVideos` | `500`   | How many videos a `--full` run lists per channel or playlist                               |
| `prune`     | `false` | Remove sources for videos deleted from YouTube (full runs) or excluded in config (any run) |

A full run only deletes "missing" videos when it saw every source completely. If a listing hit `maxVideos` or failed, the run skips that kind of deletion, because the video may simply not have been listed.

## State between runs

| Key                       | Default             | Effect                                                                                                                                  |
| ------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `stateDir`                | `.chatbase-youtube` | Holds the skip cache, one file per job: videos with no captions or filtered out after transcription, so they are not paid for every run |
| `recheckSkippedAfterDays` | `30`                | Re-check skipped videos after this many days (captions may have been added)                                                             |

The skip cache is an optimisation. Losing it only means skipped videos are checked once more. Keep the folder between runs: the Docker image stores it in `/data`, and the GitHub Actions example caches it. Changing `languages`, `machineTranslate`, `aiFallback.enabled`, `aiFallback.skipLongerThanMin`, `includeShorts`, `minDurationSec` or `filters` makes every cached skip count as new, so the change takes effect on the next run.

## Safety: `budget` and `pricing`

| Key                         | Default | Effect                                                                                                                                                                                    |
| --------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `budget.maxUsdPerRun`       | `5`     | Stop before spending if the worst case is higher (exit code 3). The worst case is every transcript charged plus the full `aiFallback.maxMinutesPerRun` when AI fallback is on             |
| `budget.maxNewVideosPerRun` | `200`   | New videos per normal (not `--full`) run; the rest wait for the next run                                                                                                                  |
| `budget.maxDeletesPerRun`   | `10`    | Removals above this are held back unless `--allow-mass-delete`. Exclusions are checked before any spend; deletions from YouTube after the listing, when the rest of the run still applies |
| `budget.storageLimitMb`     | none    | Your Chatbase plan's training limit. The run adds videos until the next would go over, then stops (exit 3)                                                                                |
| `pricing.transcriptUsd`     | `0.001` | Price per transcript, used only for the estimate                                                                                                                                          |
| `pricing.aiMinuteUsd`       | `0.012` | Price per AI minute, used only for the estimate                                                                                                                                           |

## Environment variables

| Variable                                                                       | Needed for                                                                       |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `APIFY_TOKEN`                                                                  | Any run that fetches transcripts (not needed for `--dry-run` or `validate`)      |
| `CHATBASE_API_KEY`                                                             | `sink: rest`, including `--dry-run` (it reads what the agent already holds)      |
| `YOUTUBE_API_KEY`                                                              | Optional: complete listings for playlists over 100 videos ([get a key](https://developers.google.com/youtube/registering_an_application)) |
| `LOG_LEVEL`                                                                    | `debug`, `info` (default), `warn`, `error`. `--log-level` overrides it           |
| Anything you reference as `${VAR}`                                             | Usually `CHATBASE_AGENT_ID`                                                      |
| `SCHEDULE`, `FULL_SCHEDULE`, `HEALTHCHECK_URL`, `REPORT_WEBHOOK_URL`, `CONFIG` | Docker image only; see the [README](../README.md#quick-start-docker-on-a-server) |
