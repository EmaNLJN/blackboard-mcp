# Blackboard MCP fork

This fork starts at upstream v0.1.2. The Zoom integration is a separate, read-only
module; do not broaden `bb_raw_request` or the Blackboard HTTP host allowlist.

- Node >=22.5; TypeScript ESM. `npm install --ignore-scripts`, `npm run build`,
  `npm run typecheck`, `npm test`.
- Keep Zoom LTI authentication, recording downloads, and MCP presentation in
  separate modules. Never evaluate JavaScript returned by the remote service.
- Only replay the signed LTI launch provided by the enrolled course. Scope
  cookies to their origins and keep Zoom sessions in memory, one course at a time.
- Tests use synthetic sessions and mocked HTTP responses, never real credentials.
  Verify redirects, size limits, permission failures, dates and pagination.
- Do not commit cookies, tokens, signed URLs, real course data, downloads, browser
  captures, local configuration or machine-specific paths.
- `skills/blackboard-zoom/SKILL.md` documents tool routing and limitations.
  `ZOOM.md` documents installation and the supported Zoom LTI 1.1 surface.
