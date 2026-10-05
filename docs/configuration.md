# Configuration reference

The connector reads `chatbase-youtube.yaml` by default (`-c` to change it). `${VAR}` is replaced with an environment variable. An unset variable is an error, never an empty string. Unknown keys are rejected, so typos fail fast. Run `chatbase-youtube-sync validate` to print the resolved config.

```yaml
version: 1
defaults: { … } # applied to every job
jobs:
  - name: … # one job = one Chatbase agent (or one export folder)
```

A job inherits every key from `defaults`. Nested objects (`budget`, `filters`, `aiFallback`, `pricing`) merge one level deep, so a job can override one field and keep the rest. `exclude` lists are combined: default exclusions plus the job's own.

## Choosing videos

### What to sync: `sources`

`sources` is the allow-list: only what you list is synced. Mix any of the three kinds.

```yaml
sources:
  - channel: '@AcmeAcademy' # every video on the channel (handle, channel URL or UC… id)
  - playlist: 'PLxxxxxxxxxxxxxxxx' # only this playlist (URL or id)
  - video: 'https://youtu.be/xxxxxxxxxxx' # one video (URL or id)
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
- Excluded playlists are listed in full. Without `YOUTUBE_API_KEY` the connector reads the public playlist page, which shows the first 100 videos. For bigger playlists the run warns, and you should set `YOUTUBE_API_KEY` (a free YouTube Data API v3 key) for a complete listing.

### Rules: `filters`, `includeShorts`, `minDurationSec`

| Key                      | Default | Effect                                                                       |
| ------------------------ | ------- | ---------------------------------------------------------------------------- |
| `filters.titleInclude`   | `[]`    | Only titles matching one of these regexes (`(?i)` prefix = case-insensitive) |
| `filters.titleExclude`   | `[]`    | Drop titles matching any of these                                            |
| `filters.publishedAfter` | none    | `YYYY-MM-DD`; older videos are skipped                                       |
| `includeShorts`          | `false` | YouTube Shorts are skipped unless `true`                                     |
| `minDurationSec`         | `60`    | Skip very short videos                                                       |

Rules apply to new videos. A video already in the agent is never deleted because of a rule, only through `exclude` + `prune` or because it was removed from YouTube.

## Transcripts

| Key                            | Default                                    | Effect                                                                                |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `languages`                    | `[en]`                                     | Caption languages in order of preference                                              |
| `machineTranslate`             | `true`                                     | Translate captions from another language into your first language, keeping timestamps |
| `aiFallback.enabled`           | `false`                                    | AI speech-to-text for videos without captions (billed per minute)                     |
| `aiFallback.maxMinutesPerRun`  | `60`                                       | Hard cap on AI minutes per run                                                        |
| `aiFallback.skipLongerThanMin` | `90`                                       | Don't AI-transcribe videos longer than this                                           |
| `aiFallback.language`          | auto                                       | Force the AI transcription language                                                   |
| `actorId`                      | `codepoetry/youtube-transcript-ai-scraper` | The Apify Actor that fetches transcripts                                              |
| `actorBuild`                   | latest                                     | Pin an Actor build (e.g. `2.8.3`) for reproducible output                             |

## Output

| Key              | Default | Effect                                                                                       |
| ---------------- | ------- | -------------------------------------------------------------------------------------------- |
| `segmentSeconds` | `60`    | Length of each timestamped section; sections end on a sentence                               |
| `sink`           | `rest`  | `rest` writes to Chatbase (Standard plan or higher). `export` writes files for manual upload |
| `agentId`        | none    | Required for `sink: rest`                                                                    |
| `exportDir`      | `out`   | Where `sink: export` writes, one folder per job                                              |

## Full runs and removal

| Key         | Default | Effect                                                                                     |
| ----------- | ------- | ------------------------------------------------------------------------------------------ |
| `maxVideos` | `500`   | How many videos a `--full` run lists per source                                            |
| `prune`     | `false` | Remove sources for videos deleted from YouTube (full runs) or excluded in config (any run) |

A full run never deletes "missing" videos when the listing hit `maxVideos`. In that case the listing may just be truncated, so the run skips pruning.

## Safety: `budget` and `pricing`

| Key                         | Default | Effect                                                               |
| --------------------------- | ------- | -------------------------------------------------------------------- |
| `budget.maxUsdPerRun`       | `5`     | Abort before spending if the worst case is higher (exit code 3)      |
| `budget.maxNewVideosPerRun` | `200`   | New videos per incremental run; the rest wait for the next run       |
| `budget.maxDeletesPerRun`   | `10`    | Abort if more sources would be removed, unless `--allow-mass-delete` |
| `budget.storageLimitMb`     | none    | Your Chatbase plan's training limit. Abort before going over         |
| `pricing.transcriptUsd`     | `0.001` | Price per transcript, used for the estimate                          |
| `pricing.aiMinuteUsd`       | `0.012` | Price per AI minute, used for the estimate                           |

## Environment variables

| Variable                                | Needed for                                                |
| --------------------------------------- | --------------------------------------------------------- |
| `APIFY_TOKEN`                           | Transcription (every run except `--dry-run`)              |
| `CHATBASE_API_KEY`                      | `sink: rest`                                              |
| `YOUTUBE_API_KEY`                       | Optional: complete listings for playlists over 100 videos |
| `LOG_LEVEL`                             | `debug`, `info` (default), `warn`, `error`                |
| `HEALTHCHECK_URL`, `REPORT_WEBHOOK_URL` | Docker image only: failure alerts and run reports         |
