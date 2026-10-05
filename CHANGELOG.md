# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-10-05

### Fixed

- `${VAR}` inside a YAML comment no longer fails the config; only values are interpolated.
- A rejected Apify token now exits with code 5 (auth or plan) and a clear message, instead of 1.
- The run summary table has a Skipped column, and lists videos held back by the storage limit.

### Changed

- Docs: README rewritten around prerequisites, a setup chooser, working quick starts (including the first full backfill run) and a troubleshooting table; complete annotated example in `docs/configuration.md`; contributor guide with a project map and how to add a sink or provider.

## [0.1.0] - 2026-10-05

### Added

- `sync` keeps a Chatbase agent trained on YouTube channels, playlists or single videos. Each video becomes one text source with a timestamped `[watch](…?t=)` link about every minute, and chapters become section headings.
- Incremental mode: free discovery (channel RSS, full playlist listing) that transcribes only new videos.
- Full mode (`--full`): lists every upload, including Shorts and live recordings, updates changed transcripts and, with `prune: true`, removes videos deleted from YouTube.
- `exclude` for videos and whole playlists, plus title, date, Shorts and duration filters.
- Two sinks: the Chatbase API (`rest`, Standard plan and up) and `export` files for Free and Hobby.
- Safety: worst-case spend estimate before any Apify run, a storage limit, a delete cap, a skip cache for unusable videos, `--dry-run` and `doctor`.
- GitHub Action, Docker image (scheduled or `--once`), systemd units, JSON run report and GitHub step summary.

[Unreleased]: https://github.com/yel-hadd/chatbase-youtube-connector/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/yel-hadd/chatbase-youtube-connector/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yel-hadd/chatbase-youtube-connector/releases/tag/v0.1.0
