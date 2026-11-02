import { BlackboardError } from '../lib/errors.js';
import { ZoomHttp, ZOOM_ORIGIN, assertMediaUrl, readLimited, type ZoomSource, type Fetcher } from './http.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const arr = (v: unknown): Obj[] => Array.isArray(v) ? v.map(obj) : [];
const pick = (o: Obj, keys: string[]): Obj => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
const fail = (message: string): never => { throw new BlackboardError('UNSUPPORTED', message); };

function decode(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}
function attributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)]
    .map(m => [m[1]!.toLowerCase(), decode(m[3] ?? m[4] ?? '')]));
}

export function parseLaunch(html: string): { action: string; fields: URLSearchParams } {
  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)];
  if (forms.length !== 1) return fail('Expected one signed Zoom LTI launch form.');
  const attrs = attributes(forms[0]![1]!);
  if (attrs.action !== `${ZOOM_ORIGIN}/lti/rich` || attrs.method?.toUpperCase() !== 'POST') {
    return fail('Only the Zoom LTI 1.1 launch endpoint is supported.');
  }
  const fields = new URLSearchParams();
  for (const [tag] of forms[0]![2]!.matchAll(/<input\b[^>]*>/gi)) {
    const a = attributes(tag);
    if (!a.name) continue;
    if (a.type?.toLowerCase() !== 'hidden' || fields.has(a.name)) return fail('Unexpected input in the Zoom launch form.');
    fields.set(a.name, a.value ?? '');
  }
  if (fields.get('lti_message_type') !== 'basic-lti-launch-request' || fields.get('lti_version') !== 'LTI-1p0' || !fields.get('oauth_signature')) {
    return fail('The page is not a signed LTI 1.1 launch.');
  }
  return { action: attrs.action, fields };
}

/** Parse only literal bootstrap fields. Never run remote scripts or eval an object. */
export function parseBootstrap(html: string) {
  const script = /window\.appConf\s*=\s*\{([\s\S]*?)\}\s*;/i.exec(html)?.[1];
  if (!script) return fail('Zoom did not return its LTI bootstrap. A browser login or a newer integration may be required.');
  const scid = /\bscid\s*:\s*"([^"\r\n]+)"/.exec(script)?.[1];
  if (!scid) return fail('Zoom did not return a course scope.');
  const allowed = new Set(['x-zm-cluster-id', 'x-zm-aid', 'x-zm-haid', 'x-zm-region', 'x-xsrf-token']);
  const headers: Record<string, string> = {};
  for (const m of script.matchAll(/\{\s*key\s*:\s*"([^"\r\n]+)"\s*,\s*value\s*:\s*"([^"\r\n]*)"\s*\}/g)) {
    if (allowed.has(m[1]!.toLowerCase())) headers[m[1]!] = m[2]!;
  }
  const flag = (key: string) => new RegExp(`\\b${key}\\s*:\\s*true\\b`).test(script);
  return { scid, headers, tabs: {
    upcomingMeetings: true, previousMeetings: true,
    recordings: flag('showCloudRecordingTab'), summaries: flag('isZoomAicSummaryFeatureOn'),
    whiteboards: flag('isWhiteboardFeatureOn'), documents: flag('isDocsFeatureOn'),
    notes: flag('isMyNotesFeatureOn'), chat: flag('enableChatChannelFeature'),
  } };
}

function utc(value: unknown): string | undefined {
  const s = str(value);
  if (!s) return undefined;
  return /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? s.replace(' ', 'T') + 'Z' : /T.*(?:Z|[+-]\d\d:\d\d)$/.test(s) ? s : undefined;
}
function recordingInfo(r: Obj) {
  return { ...pick(r, ['meetingId', 'meetingNumber', 'topic', 'timezone', 'duration', 'recordingCount', 'totalSize', 'listStartTime']),
    startTimeUtc: utc(r.startTime), startTimeDisplay: utc(r.startTime) ? undefined : str(r.startTime) || undefined, durationUnit: 'minutes' };
}
function fileInfo(f: Obj) {
  return { ...pick(f, ['id', 'fileType', 'fileSize', 'recordingStart', 'recordingEnd', 'status']),
    playUrl: str(f.playUrl) || undefined, downloadAvailable: !!(f.webDownloadUrl || f.downloadUrl),
    timeBasis: 'recording timezone (local)' };
}

export class ZoomLti {
  private constructor(readonly http: ZoomHttp, private bootstrap: ReturnType<typeof parseBootstrap>, readonly launchUrl: string) {}
  get tabs() { return this.bootstrap.tabs; }

  static async open(source: ZoomSource, content: unknown, courseId: string, contentId: string, fetcher: Fetcher = fetch): Promise<ZoomLti> {
    const item = obj(content);
    const handler = str(item.contentHandler);
    const detail = obj(obj(item.contentDetail)[handler]);
    if (!handler.startsWith('resource/x-bb-bltiplacement-') || obj(detail.placement).url !== `${ZOOM_ORIGIN}/lti/rich` ||
        item.id !== contentId || (item.courseId !== undefined && item.courseId !== courseId)) return fail('This item is not a Zoom LTI 1.1 placement in the requested course.');
    const launch = new URL(str(detail.launchLink), source.baseUrl);
    if (launch.origin !== source.baseUrl || launch.pathname !== '/webapps/blackboard/execute/blti/launchPlacement' ||
        launch.searchParams.get('course_id') !== courseId || launch.searchParams.get('content_id') !== contentId ||
        !launch.searchParams.get('blti_placement_id')) return fail('Zoom launch does not match the requested course and content.');
    const http = new ZoomHttp(source, fetcher);
    const launchHtml = await readLimited(await http.request(launch.href, { mode: 'blackboard' }));
    const form = parseLaunch(launchHtml);
    const page = await readLimited(await http.request(form.action, { mode: 'zoom', method: 'POST', body: form.fields }));
    return new ZoomLti(http, parseBootstrap(page), launch.href);
  }

  private async api(path: string, params: Record<string, string | number | undefined> = {}): Promise<Obj> {
    const url = new URL('/api/v1/lti/rich/' + path, ZOOM_ORIGIN);
    url.searchParams.set('lti_scid', this.bootstrap.scid);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    const response = await this.http.request(url.href, { mode: 'zoom', headers: this.bootstrap.headers });
    let data: Obj;
    try { data = obj(JSON.parse(await readLimited(response))); }
    catch (error) { if (error instanceof BlackboardError) throw error; return fail('Zoom returned a page instead of API data.'); }
    if (data.status !== true || !data.result || typeof data.result !== 'object') {
      throw new BlackboardError('FORBIDDEN', 'Zoom rejected this read request or returned an expired session. Re-open the course integration.');
    }
    return obj(data.result);
  }

  private paged(data: Obj, page: number, map: (o: Obj) => Obj) {
    if (!Array.isArray(data.list)) return fail('Zoom returned an unrecognised list response.');
    const rows = arr(data.list), current = Number(data.pageNum ?? page), total = Number(data.total ?? rows.length), size = Number(data.pageSize ?? rows.length);
    return { page: current, pageSize: size, total, hasNextPage: size > 0 && current * size < total, items: rows.map(map) };
  }

  async listRecordings(opts: { page?: number; from?: string; to?: string; search?: string }) {
    const page = opts.page ?? 1;
    return this.paged(await this.api('recording/COURSE', { page, total: 0, searchType: 1, startTime: opts.from ?? '', endTime: opts.to ?? '', keyWord: opts.search ?? '', status: '' }), page, recordingInfo);
  }
  async listMeetings(kind: 'upcoming' | 'past', page = 1) {
    return this.paged(await this.api(`meeting/${kind === 'past' ? 'history' : 'upComing'}/COURSE/all`, { page, total: 0 }), page,
      r => ({ ...pick(r, ['meetingId', 'meetingNumber', 'topic', 'agenda', 'startTimeStr', 'listStartTime', 'timezone', 'duration', 'type', 'recurring', 'occurrenceId', 'joinUrl']), startTimeUtc: utc(r.startTime), startTimeDisplay: utc(r.startTime) ? undefined : str(r.startTime), durationUnit: 'minutes' }));
  }
  async getMeeting(meetingNumber: string, occurrenceId?: string) {
    if (!/^\d{9,15}$/.test(meetingNumber)) throw new BlackboardError('BAD_INPUT', 'Use the meetingNumber returned by bb_zoom_list_meetings.');
    if (occurrenceId && !/^\d{1,30}$/.test(occurrenceId)) throw new BlackboardError('BAD_INPUT', 'Use the occurrenceId returned by bb_zoom_list_meetings.');
    const r = await this.api(`meeting/${meetingNumber}${occurrenceId ? '/recurring/' + occurrenceId : ''}`);
    const start = r.startTime ?? r.start_time;
    // Detail start_time may be local ISO text; only explicit offsets establish UTC.
    const startUtc = r.startTime ? utc(r.startTime) : /T.*(?:Z|[+-]\d\d:\d\d)$/.test(str(start)) ? str(start) : undefined;
    return { ...pick(r, ['topic', 'agenda', 'timezone', 'duration', 'type', 'recurrence', 'occurrences']), meetingNumber,
      joinUrl: r.joinUrl ?? r.join_url, startTimeUtc: startUtc, startTimeDisplay: startUtc ? undefined : str(start), durationUnit: 'minutes' };
  }
  async listSummaries(paginationKey?: string) {
    const r = await this.api('aic/meetingsummaries', { paginationKey, ascending: paginationKey ? 'true' : undefined });
    if (!Array.isArray(r.eduZoomAicMeetingSummaries)) return fail('Zoom returned an unrecognised summaries response.');
    return { items: arr(r.eduZoomAicMeetingSummaries).map(x => pick(x, ['meetingUuid', 'meetingId', 'meetingNumber', 'meetingTopic', 'topic', 'createDate', 'meetingStartTime', 'summaryStartTime', 'summaryEndTime'])),
      hasNextPage: r.hasNextPage === true, nextPageKey: Array.isArray(r.pageLastItemSortKeyValues) ? r.pageLastItemSortKeyValues.join('_') : undefined };
  }
  async getSummary(meetingId: string) {
    const r = await this.api(`aic/meetingsummaries/${encodeURIComponent(encodeURIComponent(meetingId))}/info`);
    return pick(r, ['meeting_topic', 'meeting_start_time', 'summary_overview', 'summary_details', 'next_steps', 'edited_summary']);
  }
  private async rawRecording(meetingId: string): Promise<Obj> {
    const r = await this.api('recording/file', { meetingId });
    if (str(r.meetingId) !== meetingId || !Array.isArray(r.recordingFiles)) return fail('Zoom returned a different or unrecognised recording.');
    return r;
  }
  private selectFile(recording: Obj, fileId?: string): Obj {
    const files = arr(recording.recordingFiles);
    const file = fileId ? files.find(f => f.id === fileId) : files.find(f => f.fileType === 'MP4' && f.playUrl) ?? files.find(f => f.playUrl);
    if (!file) throw new BlackboardError('NOT_FOUND', 'No matching playable recording file. Use a file id from bb_zoom_get_recording.');
    return file;
  }
  private async playback(file: Obj): Promise<{ data: Obj; origin: string }> {
    const url = assertMediaUrl(str(file.playUrl));
    if (!url.pathname.startsWith('/rec/play/')) return fail('Unsupported Zoom playback URL.');
    const page = await readLimited(await this.http.request(url.href, { mode: 'media' }));
    const id = /window\.(?:recordingMobilePlayData|__data__)\s*=\s*\{[\s\S]*?\bfileId:\s*'([^'\r\n]+)'/.exec(page)?.[1];
    if (!id) return fail('Zoom playback requires a browser login or uses an unsupported player.');
    const api = new URL(`/nws/recording/1.0/play/info/${encodeURIComponent(id)}`, url);
    api.searchParams.set('originDomain', url.host);
    let data: Obj;
    try { data = obj(JSON.parse(await readLimited(await this.http.request(api.href, { mode: 'media' })))); }
    catch (e) { if (e instanceof BlackboardError) throw e; return fail('Unrecognised Zoom playback response.'); }
    if (data.errorCode !== 0) throw new BlackboardError('FORBIDDEN', 'Zoom playback is not accessible to this session.');
    return { data: obj(data.result), origin: url.origin };
  }
  async getRecording(meetingId: string, fileId?: string) {
    const r = await this.rawRecording(meetingId);
    const result: Obj = { ...recordingInfo(r), files: arr(r.recordingFiles).map(fileInfo) };
    // File metadata remains useful even if the player demands a separate login.
    try {
      const f = this.selectFile(r, fileId);
      const { data } = await this.playback(f);
      result.playback = { fileId: f.id, hasTranscript: data.hasTranscript === true || arr(data.transcriptList).length > 0,
        downloadButtonEnabled: data.disableDownload === false,
        playbackFileAvailable: !!(data.mp4Url || data.viewMp4Url || data.audioUrl),
        transcribing: data.transcribing === true, durationSeconds: data.duration };
    } catch (e) { result.playback = { fileId, error: e instanceof BlackboardError ? e.describe() : 'Playback unavailable.' }; }
    return result;
  }
  async readTranscript(meetingId: string, fileId?: string, offset = 0, maxChars = 20000) {
    const r = await this.rawRecording(meetingId);
    const f = this.selectFile(r, fileId);
    const { data, origin } = await this.playback(f);
    let text = arr(data.transcriptList).map(x => `[${str(x.ts)} --> ${str(x.end_ts)}] ${str(x.username)}: ${str(x.text)}`).join('\n');
    if (!text && data.transcriptUrl) {
      const url = new URL(str(data.transcriptUrl), origin);
      text = await readLimited(await this.http.request(url.href, { mode: 'media' }), 8 * 1024 * 1024);
      if (/^\s*</.test(text)) throw new BlackboardError('FORBIDDEN', 'Zoom returned a login page instead of a transcript.');
    }
    if (!text) return { available: false, transcribing: data.transcribing === true, meetingId, fileId: f.id };
    return { available: true, meetingId, fileId: f.id, topic: r.topic, offset, totalCharacters: text.length,
      nextOffset: offset + maxChars < text.length ? offset + maxChars : null, text: text.slice(offset, offset + maxChars) };
  }
  async downloadTarget(meetingId: string, fileId: string) {
    const r = await this.rawRecording(meetingId);
    const f = this.selectFile(r, fileId);
    let url = str(f.webDownloadUrl) || str(f.downloadUrl);
    let referer: string | undefined;
    let source: 'download' | 'playback' = 'download';
    if (!url) {
      const p = await this.playback(f);
      if (p.data.waterMarkerFlag === true) return fail('Saving watermarked playback is not supported. Use the Zoom download button.');
      // disableDownload describes the UI button; an authenticated player may still
      // expose its media file. Use that URL unchanged and honor HTTP access failures.
      url = str(f.fileType === 'M4A' ? p.data.audioUrl || p.data.mp4Url : p.data.mp4Url || p.data.viewMp4Url);
      referer = p.origin + '/';
      source = 'playback';
    }
    if (!url) throw new BlackboardError('NOT_FOUND', 'Zoom did not provide a downloadable file.');
    assertMediaUrl(url);
    const ext = ({ MP4: 'mp4', M4A: 'm4a', TRANSCRIPT: 'vtt', CHAT: 'txt', TIMELINE: 'json' } as Record<string, string>)[str(f.fileType)] ?? 'bin';
    const expectedMedia = f.fileType === 'MP4' ? 'video' as const : f.fileType === 'M4A' ? 'audio' as const : undefined;
    return { url, referer, source, expectedMedia, expectedBytes: typeof f.fileSize === 'number' ? f.fileSize : undefined, fileName: `${str(r.topic)}-${str(f.recordingStart)}-${str(f.id)}.${ext}` };
  }
}
