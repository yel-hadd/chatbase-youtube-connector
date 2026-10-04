# Security policy

Please report vulnerabilities privately via GitHub Security Advisories on this repository, not in public issues. We aim to respond within 3 working days.

The connector handles two secrets, `APIFY_TOKEN` and `CHATBASE_API_KEY`. They are read only from environment variables, never written to disk, and redacted from logs and reports.
