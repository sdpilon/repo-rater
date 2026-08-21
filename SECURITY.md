# Security Policy

Repo Rater is a self-hosted personal tool — each instance runs against
its own deployer's database and credentials (GitHub PAT, Anthropic key,
optional password gate), so there's no shared hosted service with a
central attack surface to protect. That said, vulnerabilities in the
code itself — an auth bypass, an injection path in the pipeline or
database layer, anything that could put a self-hoster's data or
credentials at risk — are worth reporting responsibly.

## Reporting a vulnerability

Email **sdpilon@pm.me** with details rather than opening a public issue.
There's no guaranteed response time — this is maintained by one person
in their spare time — but reports will be read and taken seriously.

## Supported versions

There's a single line of development (`main`); no version matrix to
track.
