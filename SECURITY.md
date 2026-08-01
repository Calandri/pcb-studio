# Security

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Report them
privately to the maintainer (GitHub private vulnerability report or a direct
message), and you will get an answer as soon as possible.

## Notes for self-hosters

- All secrets live in environment variables (see `.env.example`). The database
  stores only **hashes** of API tokens and **encrypted** LLM keys (BYOK).
- Datasheets, EasyEDA imports, and other external content are treated as
  untrusted input: the agent is instructed never to follow instructions found
  inside them (prompt-injection guard).
- Every API route enforces project-level ACL; MCP access uses personal tokens
  (`pcbs_…`) with the same permissions as the owning user.
