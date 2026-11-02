# Zoom course tools

This fork adds Zoom LTI 1.1 support to Blackboard MCP. It uses the enrolled
course's signed launch and the same Zoom course/player endpoints as the web UI.
It needs an existing Blackboard session, not a Zoom OAuth app or account-wide API
key. The upstream Blackboard raw-request allowlist is unchanged.

## Install from this fork

Use Node >=22.5 and the development commands already used by the repository:

```sh
git clone --branch feat/zoom-lti https://github.com/EmaNLJN/blackboard-mcp.git
cd blackboard-mcp
npm install --ignore-scripts
npm run build
npm run typecheck
npm test
```

For Codex, register this built checkout with the native CLI, which preserves
unrelated server entries:

```sh
codex mcp add blackboard --env BLACKBOARD_MCP_ALLOW_WRITES=0 -- \
  "$(command -v node)" "$PWD/dist/cli.js" serve
```

Use an absolute Node executable available to GUI clients; a version manager's
shell shim may require its explicit `exec` invocation. Other clients can render
local registration with `node dist/cli.js install CLIENT --local`. Review the
result and use the client's supported config mechanism. Keep resolved machine
paths only in local config. Restart the client after registration.

The existing encrypted Blackboard session is reused. Check that the effective
`allowWrites` setting is false if you want the entire server to remain read-only;
this fork's Zoom tools never expose meeting edits, submissions or deletions.

The optional reusable skill is `skills/blackboard-zoom/SKILL.md`. Copy its folder
into your client's skill directory (for example `~/.agents/skills` for Codex),
or manage that copy with your existing dotfiles tool. It contains no course IDs,
credentials or machine paths. A skill alone does not install an MCP server.

## Tools

All tools accept `courseId`. `contentId` is optional unless multiple Zoom
placements exist in the course.

| Tool | Reads or saves |
| --- | --- |
| `bb_zoom_sections` | Enabled and supported Zoom tabs |
| `bb_zoom_list_meetings` | Upcoming or previous classes, one page at a time |
| `bb_zoom_get_meeting` | Schedule, agenda and recurrence by numeric meetingNumber |
| `bb_zoom_list_recordings` | Recording dates and metadata, with date/search filters |
| `bb_zoom_get_recording` | Files and playback metadata for a recording meetingId |
| `bb_zoom_read_transcript` | Original timestamped transcript, paged by character offset |
| `bb_zoom_download_file` | One selected video/audio or other downloadable file |
| `bb_zoom_list_summaries` | Shared AI Companion summaries, with a cursor |
| `bb_zoom_get_summary` | A summary by the list's meetingUuid |

Navigate **Course Recordings → date → files → selected player**. Multiple video
and audio segments can belong to a single date. The player can expose a transcript
in its sidebar even when the LTI file list contains no TRANSCRIPT entry.
`nextOffset` supports reading the whole transcript; `hasNextPage` and
`nextPageKey` support list pagination. A missing transcript, processing transcript,
permission failure and empty class list are different results.

UTC list timestamps are returned as `startTimeUtc`. Localized display dates and
local recording segment times remain explicitly local; consumers must use the
reported timezone. Durations identify their units.

## Downloads

Downloads prefer the LTI file download link and otherwise use the media URL
returned by that selected player's authenticated response. Recording CDNs need
the player-origin `Referer`. `disableDownload` reflects the player button; it
alone does not establish whether the playback media can be saved. HTTP access
failures remain errors. Watermarked playback fallback is unsupported.

Files stream to the configured download directory, with private permissions,
unique sanitized names and a SHA-256 result. Partial files are removed after a
failed transfer. `BLACKBOARD_MCP_MAX_DOWNLOAD_BYTES` controls the size ceiling
(default inherited from Blackboard MCP); transfers currently have a 120-second
request/body timeout. A large file on a slow connection may exceed that timeout.
The result identifies `source: download` or `source: playback`; signed media URLs
and session headers are not returned in download results.

No additional runtime dependency is required. Context7 was used to assess:

- [yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/zoom.py),
  whose Zoom extractor resolves playback/share links and supplies a Referer.
- [Playwright downloads](https://playwright.dev/docs/downloads), useful when a
  future player requires clicking an actual button inside an iframe.

These are alternatives to investigate when needed, not installed dependencies
or a guarantee that another tenant's login flow will work.

## Scope and verification

Supported: Zoom's `applications.zoom.us/lti/rich` LTI 1.1 placement, upcoming/past
meetings, cloud recordings and shared summaries. Enabled unsupported tabs are
reported explicitly. LTI 1.3, personal Zoom accounts, editing, joining meetings,
DRM, watermarked playback exports and automatic speech recognition are outside
this implementation. Internal endpoints may change without notice.

Live validation exercised course launch, class/recording lists, recording
segments, desktop/mobile transcript discovery, and short MP4/M4A downloads. The
saved media was inspected as actual video/audio, not HTML. Shared summaries were
empty in the tested course; cursor/detail behavior is covered with synthetic
fixtures, not a populated live summary. A full large recording was not downloaded.
Zoom denied the tested past meeting's detail request; its list metadata remained
available. Recurring detail selection is covered with a synthetic response shaped
after the course application's meeting form.
No real course content or session artifacts belong in this repository.

Tests follow the project's `node:test` and stdio MCP protocol patterns. They
cover course-bound launches, host/cookie/header boundaries, redirects, denied
requests, date labeling, pagination, selected segments, transcripts, streamed
size limits and filename safety. Run `npm run build`, `npm run typecheck` and
`npm test`; the upstream CI matrix also runs other supported Node/OS combinations.
