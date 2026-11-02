import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, guard, text } from './helpers.js';
import { BlackboardError } from '../lib/errors.js';
import { courseSubdir } from '../lib/files.js';
import { downloadDir } from '../lib/paths.js';
import { ZoomLti } from '../zoom/lti.js';
import { saveZoomFile } from '../zoom/files.js';

const scope = {
  courseId: z.string().min(1).describe('Blackboard course id from bb_list_courses.'),
  contentId: z.string().optional().describe('Zoom placement content id. Omit to discover it within this course.'),
};
const recording = { ...scope, meetingId: z.string().min(1).max(500).describe('Opaque recording meetingId from bb_zoom_list_recordings; not the numeric meetingNumber.') };
const fileId = z.string().min(1).max(300).describe('File id from bb_zoom_get_recording.');
const page = z.number().int().min(1).max(10000).optional().describe('One page per call; follow hasNextPage. Default 1.');
const annotations = { readOnlyHint: true, openWorldHint: true };
const output = (value: unknown) => text(JSON.stringify(value, null, 2));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

async function connect(args: { courseId: string; contentId?: string }) {
  const client = await getClient();
  let id = args.contentId;
  if (!id) {
    const nodes = await client.walkContents(args.courseId, { maxDepth: 8, maxNodes: 600 });
    const matches = nodes.filter(n => n.contentHandler?.startsWith('resource/x-bb-bltiplacement-') && /zoom/i.test(`${n.contentHandler} ${n.title}`));
    if (matches.length !== 1) throw new BlackboardError(matches.length ? 'BAD_INPUT' : 'NOT_FOUND',
      matches.length ? 'Multiple Zoom placements found. Pass a contentId from bb_browse_course.' : 'No Zoom placement found in this course. Check bb_browse_course.');
    id = matches[0]!.id;
  }
  const item = await client.getContent(args.courseId, id);
  const zoom = await ZoomLti.open(client.http.session, item, args.courseId, id);
  return { client, zoom, contentId: id };
}

export function registerZoomTools(server: McpServer): void {
  server.registerTool('bb_zoom_sections', {
    title: 'Inspect course Zoom sections', description: 'Opens the course Zoom LTI integration and reports enabled tabs. Upcoming/past meetings, cloud recordings and summaries have dedicated tools. Disabled or unsupported tabs are reported explicitly.', inputSchema: scope, annotations,
  }, guard('bb_zoom_sections', async args => {
    const { zoom, contentId } = await connect(args);
    return output({ courseId: args.courseId, contentId, launchUrl: zoom.launchUrl, enabledSections: zoom.tabs,
      supported: ['upcomingMeetings', 'previousMeetings', 'recordings', 'summaries'],
      note: 'Enabled tabs are not proof of available content. Meeting starts, edits and deletions are not exposed.' });
  }));
  server.registerTool('bb_zoom_list_meetings', {
    title: 'List upcoming or previous Zoom classes', description: 'Reads one page of scheduled upcoming classes or previous meetings for this course. Includes the available dates, timezone, duration and meeting identifiers. An empty list does not prove classes were not announced elsewhere.',
    inputSchema: { ...scope, kind: z.enum(['upcoming', 'past']).optional(), page }, annotations,
  }, guard('bb_zoom_list_meetings', async args => output(await (await connect(args)).zoom.listMeetings(args.kind ?? 'upcoming', args.page))));
  server.registerTool('bb_zoom_get_meeting', {
    title: 'Read Zoom meeting schedule details', description: 'Reads one scheduled Zoom meeting, including its agenda, timezone and recurrence information when exposed. Does not start or join the meeting.',
    inputSchema: { ...scope, meetingNumber: z.string().regex(/^\d{9,15}$/) }, annotations,
  }, guard('bb_zoom_get_meeting', async args => output(await (await connect(args)).zoom.getMeeting(args.meetingNumber))));
  server.registerTool('bb_zoom_list_recordings', {
    title: 'List course Zoom recordings', description: 'Lists a page of cloud recordings with meetingId, topic, UTC start time, timezone, duration in minutes, file count and total bytes. Use bb_zoom_get_recording for files and player permissions.',
    inputSchema: { ...scope, page, from: date.describe('Start date YYYY-MM-DD.'), to: date.describe('End date YYYY-MM-DD.'), search: z.string().max(200).optional() }, annotations,
  }, guard('bb_zoom_list_recordings', async args => {
    if (args.from && args.to && args.from > args.to) throw new BlackboardError('BAD_INPUT', 'from must not be after to.');
    return output(await (await connect(args)).zoom.listRecordings(args));
  }));
  server.registerTool('bb_zoom_get_recording', {
    title: 'Read Zoom video metadata and files', description: 'Reads recording files, formats, sizes, local recording timestamps and playback links. Also checks one selected video/audio player for transcript availability and download permissions, which can differ from the LTI file list.',
    inputSchema: { ...recording, fileId: fileId.optional() }, annotations,
  }, guard('bb_zoom_get_recording', async args => output(await (await connect(args)).zoom.getRecording(args.meetingId, args.fileId))));
  server.registerTool('bb_zoom_read_transcript', {
    title: 'Read a Zoom recording transcript', description: 'Reads the transcript exposed by the video player, even if LTI has no TRANSCRIPT file. Returns timestamped text in character windows. Follow nextOffset to continue. Missing, processing and denied transcripts are distinct outcomes.',
    inputSchema: { ...recording, fileId: fileId.optional(), offset: z.number().int().min(0).optional(), maxChars: z.number().int().min(500).max(60000).optional() }, annotations,
  }, guard('bb_zoom_read_transcript', async args => output(await (await connect(args)).zoom.readTranscript(args.meetingId, args.fileId, args.offset, args.maxChars))));
  server.registerTool('bb_zoom_download_file', {
    title: 'Download an available Zoom recording file', description: 'Saves a selected file to the configured local download directory. Uses a download URL or the media file exposed by the accessible player with its required Referer. The disabled download button alone does not prove the media is inaccessible. Honors HTTP access failures and maxDownloadBytes; removes partial files on failure.',
    inputSchema: { ...recording, fileId }, annotations,
  }, guard('bb_zoom_download_file', async args => {
    const { zoom, client } = await connect(args);
    const target = await zoom.downloadTarget(args.meetingId, args.fileId);
    const name = await client.courseName(args.courseId);
    return output({ ...await saveZoomFile(zoom.http, target.url, { ...target,
      dir: courseSubdir(client.config.downloadDir ?? downloadDir(), name + ' Zoom'), maxBytes: client.config.maxDownloadBytes }), source: target.source });
  }));
  server.registerTool('bb_zoom_list_summaries', {
    title: 'List Zoom AI meeting summaries', description: 'Lists AI Companion meeting summaries shared with this course. Follow nextPageKey only when hasNextPage is true. These summaries are generated by AI and are not verbatim transcripts.',
    inputSchema: { ...scope, paginationKey: z.string().max(2000).optional() }, annotations,
  }, guard('bb_zoom_list_summaries', async args => output(await (await connect(args)).zoom.listSummaries(args.paginationKey))));
  server.registerTool('bb_zoom_get_summary', {
    title: 'Read a shared Zoom AI meeting summary', description: 'Reads the overview, details and next steps of an AI Companion meeting summary available to the current course. Verify factual claims against the timestamped transcript when possible.',
    inputSchema: { ...scope, meetingUuid: z.string().min(1).max(500).describe('Opaque meetingUuid from bb_zoom_list_summaries.') }, annotations,
  }, guard('bb_zoom_get_summary', async args => output(await (await connect(args)).zoom.getSummary(args.meetingUuid))));
}
