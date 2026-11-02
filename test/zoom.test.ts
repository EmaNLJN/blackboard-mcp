import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLaunch, parseBootstrap, ZoomLti } from '../dist/zoom/lti.js';
import { ZoomHttp, readLimited } from '../dist/zoom/http.js';
import { saveZoomFile } from '../dist/zoom/files.js';

const origin = 'https://campus.example.edu';
const source = { baseUrl: origin, userAgent: 'test', cookieHeader: async () => 'BbRouter=synthetic' };
const launch = `${origin}/webapps/blackboard/execute/blti/launchPlacement?course_id=_1_1&content_id=_2_1&blti_placement_id=_3_1&wrapped=true`;
const item = { id: '_2_1', courseId: '_1_1', contentHandler: 'resource/x-bb-bltiplacement-Zoom', contentDetail: {
  'resource/x-bb-bltiplacement-Zoom': { launchLink: launch, placement: { url: 'https://applications.zoom.us/lti/rich' } },
} };
const form = `<form method="POST" action="https://applications.zoom.us/lti/rich"><input type="hidden" name="lti_message_type" value="basic-lti-launch-request"><input type="hidden" name="lti_version" value="LTI-1p0"><input type="hidden" name="oauth_signature" value="a&amp;b"><input type="hidden" name="context_title" value="Course"></form>`;
const page = `window.appConf = {page:{scid:"course-scope",showCloudRecordingTab:true,isZoomAicSummaryFeatureOn:true},ajaxHeaders:[{key:"X-XSRF-TOKEN",value:"zoom-csrf"}]};`;
const json = (result: unknown) => new Response(JSON.stringify({ status: true, result }), { headers: { 'content-type': 'application/json' } });

test('parses only signed Zoom LTI 1.1 forms, decodes values and never executes scripts', () => {
  assert.equal(parseLaunch(form).fields.get('oauth_signature'), 'a&b');
  for (const html of [form.replace('applications.zoom.us', 'evil.example'), form.replace('POST', 'GET'), form.replace('oauth_signature', 'other'), form.replace('LTI-1p0','LTI-1p3')]) {
    assert.throws(() => parseLaunch(html));
  }
  assert.throws(() => parseLaunch(form + form));
  assert.equal(parseBootstrap(page + '; throw new Error("must not execute")').scid, 'course-scope');
  assert.throws(() => parseBootstrap('window.appConf = {}'));
});

test('LTI exchange isolates Blackboard cookies and API headers, preserving pagination', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fake: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url === launch) return new Response(form);
    if (url === 'https://applications.zoom.us/lti/rich') {
      assert.equal(new Headers(init?.headers).get('cookie'), null);
      assert.equal(init?.method, 'POST');
      return new Response(page, { headers: { 'set-cookie': 'zoom_session=synthetic; Secure; Path=/' } });
    }
    assert.equal(new Headers(init?.headers).get('X-XSRF-TOKEN'), 'zoom-csrf');
    assert.equal(new Headers(init?.headers).get('cookie'), 'zoom_session=synthetic');
    const q = new URL(url).searchParams;
    assert.equal(q.get('page'), '2'); assert.equal(q.get('lti_scid'), 'course-scope');
    return json({ list: [{ meetingId: 'meeting', topic: 'Networks', startTime: '2026-10-27 21:37:46', timezone: 'America/Argentina/Buenos_Aires', hostEmail: 'private@example.edu' }], total: 21, pageNum: 2, pageSize: 10 });
  };
  const zoom = await ZoomLti.open(source, item, '_1_1', '_2_1', fake);
  const result = await zoom.listRecordings({ page: 2 });
  assert.equal(result.page, 2); assert.equal(result.total, 21); assert.equal(result.hasNextPage, true);
  assert.equal(result.items[0]?.startTimeUtc, '2026-10-27T21:37:46Z');
  assert.equal(JSON.stringify(result).includes('private@example.edu'), false);
  assert.equal(calls.length, 3);
});

test('rejects a foreign course placement before any network request', async () => {
  let calls = 0;
  await assert.rejects(ZoomLti.open(source, item, '_other_1', '_2_1', async () => { calls++; return new Response(); }));
  assert.equal(calls, 0);
});

test('rejects cross-origin redirects and loops without forwarding auth', async () => {
  let calls = 0;
  const http = new ZoomHttp(source, async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }); });
  await assert.rejects(http.request('https://applications.zoom.us/lti/rich', { mode: 'zoom' }));
  assert.equal(calls, 1);
  const loop = new ZoomHttp(source, async () => new Response(null, { status: 302, headers: { location: '/loop' } }));
  await assert.rejects(loop.request('https://applications.zoom.us/loop', { mode: 'zoom' }), /redirect/i);
});

test('upstream denial is an error, never an empty recording list', async () => {
  let calls = 0;
  const zoom = await ZoomLti.open(source, item, '_1_1', '_2_1', async () => {
    calls++; return calls === 1 ? new Response(form) : calls === 2 ? new Response(page) : new Response('{"status":false,"errorMessage":"secret-value"}', { headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(zoom.listRecordings({}), (e: Error) => /rejected/i.test(e.message) && !e.message.includes('secret-value'));
});

test('stream ceiling catches undeclared oversized content', async () => {
  await assert.rejects(readLimited(new Response('too large'), 3), /limit/i);
});

test('download streams to a private file and removes a partial file on overflow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-zoom-'));
  const http = new ZoomHttp(source, async () => new Response('WEBVTT\n\n00:00.000 --> 00:01.000\nhello', { headers: { 'content-type': 'text/vtt' } }));
  const result = await saveZoomFile(http, 'https://us02web.zoom.us/rec/download/file', { dir, fileName: '../lecture.vtt', maxBytes: 100 });
  assert.equal(await readFile(result.path, 'utf8'), 'WEBVTT\n\n00:00.000 --> 00:01.000\nhello');
  assert.ok(result.path.startsWith(dir + '/')); assert.equal(result.sha256.length, 64);
  const before = await readdir(dir);
  await assert.rejects(saveZoomFile(http, 'https://us02web.zoom.us/rec/download/file', { dir, fileName: 'fail.vtt', maxBytes: 3 }));
  assert.deepEqual(await readdir(dir), before);
});

function playerFetch(playerName: string, playback: Record<string, unknown>, requests: string[]): typeof fetch {
  return async input => {
    const url = String(input); requests.push(url);
    if (url === launch) return new Response(form);
    if (url === 'https://applications.zoom.us/lti/rich') return new Response(page);
    if (url.includes('/recording/file?')) return json({ meetingId: 'meeting', topic: 'Networks', startTime: 'Oct 27, 2026 6:37 PM', timezone: 'Buenos Aires, Georgetown', recordingFiles: [
      { id: 'part1', fileType: 'MP4', fileSize: 42, playUrl: 'https://us02web.zoom.us/rec/play/part1' },
      { id: 'part2', fileType: 'MP4', fileSize: 42, playUrl: 'https://us02web.zoom.us/rec/play/part2' },
    ] });
    if (url.includes('/rec/play/part')) return new Response(`window.${playerName} = {fileId: 'play-${url.endsWith('part2') ? '2' : '1'}', isLogin:false};`);
    if (url.includes('/nws/recording/1.0/play/info/')) return new Response(JSON.stringify({ errorCode: 0, result: playback }));
    throw new Error('Unexpected fetch');
  };
}
for (const player of ['recordingMobilePlayData', '__data__']) {
  test(`reads timestamped transcript for selected segment in ${player} without requiring download permission`, async () => {
    const requests: string[] = [];
    const zoom = await ZoomLti.open(source, item, '_1_1', '_2_1', playerFetch(player, {
      disableDownload: true, hasTranscript: true, transcriptList: [{ ts: '00:01:00', end_ts: '00:01:03', username: 'Teacher', text: 'Second exam covers IP.' }], mp4Url: 'https://ssrweb.zoom.us/video.mp4',
    }, requests));
    const tr = await zoom.readTranscript('meeting', 'part2', 0, 20);
    assert.equal(tr.available, true); assert.equal(tr.nextOffset, 20); assert.match(tr.text ?? '', /00:01:00/);
    assert.ok(requests.some(x => x.includes('/play/info/play-2')));
    assert.equal((await zoom.downloadTarget('meeting', 'part2')).source, 'playback');
    assert.ok(!requests.some(x => x.includes('video.mp4')));
  });
}
test('missing transcript is distinct from a playback access error', async () => {
  const zoom = await ZoomLti.open(source, item, '_1_1', '_2_1', playerFetch('recordingMobilePlayData', { transcriptList: [], transcribing: true }, []));
  const tr = await zoom.readTranscript('meeting');
  assert.equal(tr.available, false); assert.equal(tr.transcribing, true);
});
test('localized start time is not mislabeled as UTC', async () => {
  const zoom = await ZoomLti.open(source, item, '_1_1', '_2_1', playerFetch('recordingMobilePlayData', { disableDownload: false }, []));
  const r = await zoom.getRecording('meeting');
  assert.equal(r.startTimeUtc, undefined);
  assert.equal(r.startTimeDisplay, 'Oct 27, 2026 6:37 PM');
});

test('media requests use a validated origin-only Referer without forwarding API headers', async () => {
  const http = new ZoomHttp(source, async (_url, init) => {
    const h = new Headers(init?.headers);
    assert.equal(h.get('referer'), 'https://us02web.zoom.us/');
    assert.equal(h.get('X-XSRF-TOKEN'), null);
    assert.equal(h.get('cookie'), null);
    return new Response('video');
  });
  await http.request('https://ssrweb.zoom.us/video.mp4', { mode: 'media', referer: 'https://us02web.zoom.us/rec/play/private?secret=value', headers: { 'X-XSRF-TOKEN': 'secret' } });
  await assert.rejects(http.request('https://ssrweb.zoom.us/video.mp4', { mode: 'media', referer: 'https://evil.example/' }));
});

test('download resolves the playable MP4 even when the download button is disabled', async () => {
  const zoom = await ZoomLti.open(source, item, '_1_1', '_2_1', playerFetch('__data__', {
    disableDownload: true, mp4Url: 'https://ssrweb.zoom.us/video.mp4',
  }, []));
  const target = await zoom.downloadTarget('meeting', 'part2');
  assert.equal(target.url, 'https://ssrweb.zoom.us/video.mp4');
  assert.equal(target.referer, 'https://us02web.zoom.us/');
  assert.equal(target.source, 'playback');
});

test('metadata remains accessible without a playable recording', async () => {
  const zoom = await ZoomLti.open(source, item, '_1_1', '_2_1', async input => {
    if (String(input) === launch) return new Response(form);
    if (String(input).endsWith('/lti/rich')) return new Response(page);
    return json({ meetingId: 'meeting', recordingFiles: [{ id: 'pending', fileType: 'MP4', status: 'processing' }] });
  });
  const result = await zoom.getRecording('meeting');
  assert.equal((result.files as unknown[]).length, 1);
  assert.ok(result.playback);
});

test('summary pagination follows the cursor and encodes opaque UUID twice', async () => {
  const zoom = await ZoomLti.open(source, item, '_1_1', '_2_1', async input => {
    const url = new URL(String(input));
    if (url.href === launch) return new Response(form);
    if (url.pathname === '/lti/rich') return new Response(page);
    if (url.pathname.endsWith('/info')) {
      assert.ok(url.pathname.includes('%252F'));
      return json({ summary_overview: 'A lesson' });
    }
    assert.equal(url.searchParams.get('paginationKey'), 'next_cursor');
    assert.equal(url.searchParams.get('ascending'), 'true');
    return json({ eduZoomAicMeetingSummaries: [{ meetingUuid: '/meeting==' }], hasNextPage: false });
  });
  assert.equal((await zoom.listSummaries('next_cursor')).items.length, 1);
  assert.equal((await zoom.getSummary('/meeting==')).summary_overview, 'A lesson');
});

test('download filenames fit byte limits for non-ASCII course names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-zoom-name-'));
  const http = new ZoomHttp(source, async () => new Response('video'));
  const file = await saveZoomFile(http, 'https://ssrweb.zoom.us/video.mp4', { dir, fileName: '界'.repeat(200) + '.mp4', maxBytes: 100 });
  assert.ok(Buffer.byteLength(file.path.split('/').at(-1)!) <= 255);
  assert.ok(file.path.endsWith('.mp4'));
});
