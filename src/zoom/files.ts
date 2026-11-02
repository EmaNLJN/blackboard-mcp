import { mkdir, open, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { safeFileName } from '../lib/files.js';
import { BlackboardError } from '../lib/errors.js';
import type { ZoomHttp } from './http.js';

/** Stream recordings rather than buffering multi-GB videos. Partial files are removed. */
export async function saveZoomFile(http: ZoomHttp, url: string, opts: {
  dir: string; fileName: string; maxBytes: number; expectedBytes?: number; referer?: string; expectedMedia?: 'video' | 'audio';
}) {
  if (opts.expectedBytes !== undefined && opts.expectedBytes > opts.maxBytes) {
    throw new BlackboardError('BAD_INPUT', 'Zoom file exceeds maxDownloadBytes. Raise the configured ceiling to download it.');
  }
  const response = await http.request(url, { mode: 'media', timeoutMs: 120_000, referer: opts.referer });
  const mime = response.headers.get('content-type') ?? 'application/octet-stream';
  if (/text\/html/i.test(mime)) {
    await response.body?.cancel(); throw new BlackboardError('FORBIDDEN', 'Zoom returned a sign-in or permission page instead of a file.');
  }
  if (opts.expectedMedia && /^(audio|video)\//i.test(mime) && !mime.toLowerCase().startsWith(opts.expectedMedia + '/')) {
    await response.body?.cancel(); throw new BlackboardError('UPSTREAM', 'Zoom returned a different media type than the selected file.');
  }
  if (Number(response.headers.get('content-length')) > opts.maxBytes) {
    await response.body?.cancel(); throw new BlackboardError('BAD_INPUT', 'Zoom file exceeds the download size limit.');
  }
  await mkdir(opts.dir, { recursive: true, mode: 0o700 });
  const safeName = safeFileName(opts.fileName), ext = extname(safeName).slice(0, 12);
  let stem = Array.from(safeName.slice(0, safeName.length - extname(safeName).length));
  while (Buffer.byteLength(stem.join('') + ext) > 200) stem.pop();
  const fileName = stem.join('') + ext;
  const path = join(opts.dir, `${randomUUID().slice(0, 8)}-${fileName}`);
  const file = await open(path, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    if (!response.body) throw new BlackboardError('UPSTREAM', 'Zoom returned no file body.');
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > opts.maxBytes) throw new BlackboardError('BAD_INPUT', 'Zoom file exceeds the download size limit.');
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    await file.close();
    return { path, fileName, bytes, mimeType: mime.split(';')[0], sha256: hash.digest('hex') };
  } catch (error) {
    await file.close(); await unlink(path).catch(() => {}); throw error;
  }
}
