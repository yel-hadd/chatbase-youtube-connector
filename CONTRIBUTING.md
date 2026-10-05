# Contributing

Thanks for helping. Bug reports, fixes and focused features are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Keep pull requests focused: one change per PR. Every option and file should earn its place.

## Development

Requires Node.js 20 or newer.

```bash
npm ci
npm run check      # typecheck, lint, format check, tests with coverage gates
npm run build
```

Tests never touch real APIs: Chatbase, Apify and YouTube are faked, using fixtures recorded from real responses in `test/fixtures`. If you change how an API is called, update or add a fixture-backed test.

Try a change end to end without spending anything:

```bash
node dist/cli.js -c examples/chatbase-youtube.yaml sync --dry-run --pretty
```

## Pull requests

- Add or update tests for behaviour changes.
- Update `README.md` / `docs/configuration.md` when you change user-facing behaviour.
- Add a line under **Unreleased** in `CHANGELOG.md`.
- CI must be green: `npm run check` runs the same gates.

## Releases

Maintainers tag `vX.Y.Z` and move the major tag (`v1`). The release workflow publishes the Docker image to GHCR.

By contributing you agree that your contributions are licensed under the MIT License.
