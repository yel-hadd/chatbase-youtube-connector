# Security policy

Please report vulnerabilities privately via GitHub Security Advisories on this repository, not in public issues. We aim to respond within 3 working days.

The connector handles up to three secrets: `APIFY_TOKEN`, `CHATBASE_API_KEY` and optionally `YOUTUBE_API_KEY`. They are read only from environment variables, never written to disk or into reports, and masked in logs.
