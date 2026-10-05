# Contributing

Thanks for helping. Bug reports, fixes and focused features are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Keep pull requests focused: one change per PR. Every option and file should earn its place.

## Development

Requires Node.js 20 or newer (`.nvmrc` pins 22).

```bash
npm ci             # installs dependencies and builds dist/ (the `prepare` script runs `npm run build`)
npm run check      # typecheck, eslint, prettier check, tests with coverage thresholds — the same gates as CI
npm run build      # rebuild dist/ after a change
npm run dev -- --help   # run the CLI from source with tsx, no build needed
npm run format     # fix formatting
```

Try a change end to end without spending anything or needing a Chatbase account. This reads the Chatbase YouTube channel's RSS feed and prints the plan:

```bash
node dist/cli.js -c examples/e2e-export.yaml sync --dry-run --pretty
CHATBASE_AGENT_ID=x node dist/cli.js -c examples/chatbase-youtube.yaml validate
```

Never run a sync without `--dry-run` unless you mean to spend Apify credit and write to an agent.

## Project layout

```
src/
  cli.ts             CLI entry point: flags, wiring of provider + sink per job, exit codes
  sync.ts            The sync engine for one job: discover, guard, transcribe, format, diff, apply
  budget.ts          Worst-case spend estimate, checked before every paid Apify run
  state.ts           Skip cache: videos that were paid for but unusable (no captions, filtered)
  report.ts          report.json and the Markdown summary (stdout and GitHub step summary)
  types.ts           Shared types and YouTube video ID / URL parsing
  version.ts         Version from package.json
  config/            YAML loading, ${VAR} substitution, zod schema with every default
  discover/          Free YouTube discovery: handle → channel ID, RSS feed, playlist listing
  providers/         Transcript providers (Apify Actor over the REST API)
  format/            Transcript → timestamped Markdown, split to fit Chatbase's size limit
  plan/              Pure logic: source naming (state in names), filters, diff → operations
  sinks/             Destinations: Chatbase REST API, export files; the Sink interface
  util/              Exit codes and errors, HTTP retry and rate limiting, redacting logger
test/                Vitest tests; test/fixtures holds recorded real API responses
examples/            Example configs and GitHub workflows linked from the README
deploy/              Docker entrypoint and systemd units
action.yml           The GitHub Action (builds from source at the pinned ref, then runs `sync`)
```

Two design points worth knowing before you change anything:

- **State lives in source names.** Each Chatbase source is named `YT·<videoId>·<hash8>·[pN·]<title>` (`src/plan/naming.ts`). The hash covers the formatted content and `FORMAT_VERSION`, so the connector needs no database. If you change the output layout in `src/format/markdown.ts`, bump `FORMAT_VERSION` so every source is rewritten once.
- **Safety checks run before spend.** In `src/sync.ts` the exclusion delete cap and the budget estimate run before the first Apify call; a cap reached later only holds back deletions. Pruning is skipped whenever a listing may be incomplete. Keep that order.

## Tests

Tests never touch real APIs. They inject fakes instead:

- `fetchFn` parameters (every HTTP client takes one) receive a fake `fetch`; see `fakeFetch` in `test/rest-sink.test.ts`.
- `syncJob` takes a `TranscriptProvider`; tests use a `FakeProvider` that answers from `test/fixtures/actor-items.json` (real Apify Actor output) and a fake RSS feed from `test/fixtures/chatbase-feed.xml`.
- The export sink writes to a temporary directory, so `test/sync.test.ts` runs the whole pipeline end to end.

If you change how an API is called, add or update a fixture-backed test. Coverage thresholds (in `vitest.config.ts`) apply to `src/plan`, `src/format` and `src/sinks`.

## Adding a sink

1. Implement the `Sink` interface from `src/sinks/types.ts` in `src/sinks/<name>.ts`. `list()` must return only sources this connector wrote, with the video ID, hash and part decoded, because the diff relies on it.
2. Add the name to the `sink` enum in `src/config/schema.ts` and any settings it needs.
3. Construct it in `makeSink` in `src/cli.ts` (and add a `doctor` check if it has credentials).
4. Add tests with a fake `fetchFn`, and document it in `docs/configuration.md` and the README.

## Adding a transcript provider

1. Implement `TranscriptProvider` (`transcribe(urls, opts)`, declared in `src/sync.ts`) and return `TranscribeResult` from `src/providers/apify.ts`: transcripts plus failures with a code. Use `NO_CAPTIONS_AVAILABLE` for videos without captions, so they go to the skip cache and AI fallback.
2. `transcribe` must also accept a channel's uploads playlist or a playlist URL with `opts.maxResults`, because `--full` lists videos through the provider.
3. Wire it in `makeProvider` in `src/cli.ts`, and keep `budget.ts` estimates honest for its pricing.

## Pull requests

- Add or update tests for behaviour changes.
- Update `README.md` / `docs/configuration.md` when you change user-facing behaviour.
- Add a line under **Unreleased** in `CHANGELOG.md`.
- CI must be green: `npm run check` runs the same gates, plus CI builds the Docker image.

## Releases

Maintainers tag `vX.Y.Z` and move the major tag (`v1`). The release workflow publishes the Docker image to GHCR.

By contributing you agree that your contributions are licensed under the MIT License.
