import { CookieJar } from 'tough-cookie';
import { BlackboardError } from '../lib/errors.js';

export interface ZoomSource {
  baseUrl: string;
  userAgent: string;
  cookieHeader(url: string): Promise<string>;
}
export type Fetcher = typeof fetch;
export type Mode = 'blackboard' | 'zoom' | 'media';
export const ZOOM_ORIGIN = 'https://applications.zoom.us';

export function assertMediaUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['zoom.us', 'zoomcdn.net'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new BlackboardError('UNSUPPORTED', 'Zoom returned an unsupported file host.');
  }
  return url;
}

/** Ephemeral Zoom-only jar. Blackboard credentials are never copied into it. */
export class ZoomHttp {
  private jar = new CookieJar();
  constructor(private readonly source: ZoomSource, private readonly fetcher: Fetcher = fetch) {}

  async request(input: string, opts: {
    mode: Mode; method?: 'GET' | 'POST'; body?: URLSearchParams;
    headers?: Record<string, string>; timeoutMs?: number; referer?: string;
  }): Promise<Response> {
    let url = new URL(input);
    let method = opts.method ?? 'GET';
    let body = opts.body;
    const signal = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
    for (let hop = 0; hop < 6; hop++) {
      if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new BlackboardError('UNSUPPORTED', 'Unsafe Zoom redirect.');
      if (opts.mode === 'blackboard') {
        if (url.origin !== this.source.baseUrl || url.pathname !== '/webapps/blackboard/execute/blti/launchPlacement' || method !== 'GET') {
          throw new BlackboardError('SESSION_EXPIRED', 'Blackboard LTI launch redirected away from the course. Sign in again.');
        }
      } else if (opts.mode === 'zoom') {
        if (url.origin !== ZOOM_ORIGIN) throw new BlackboardError('UNSUPPORTED', 'Zoom LTI redirected to an unsupported origin.');
      } else assertMediaUrl(url.href);
      if (method === 'POST' && (opts.mode !== 'zoom' || url.href !== `${ZOOM_ORIGIN}/lti/rich`)) {
        throw new BlackboardError('FORBIDDEN', 'Only the signed Zoom LTI launch may be submitted.');
      }
      const headers: Record<string, string> = { 'User-Agent': this.source.userAgent };
      // API routing and CSRF headers must never reach recording/CDN hosts.
      if (opts.mode === 'zoom') Object.assign(headers, opts.headers);
      // Recording CDNs require the player origin. Never send its signed path/query.
      if (opts.mode === 'media' && opts.referer) headers.Referer = assertMediaUrl(opts.referer).origin + '/';
      const cookie = opts.mode === 'blackboard'
        ? await this.source.cookieHeader(url.href) : await this.jar.getCookieString(url.href);
      if (cookie) headers.Cookie = cookie;
      if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      let response: Response;
      try { response = await this.fetcher(url.href, { method, body, headers, redirect: 'manual', signal }); }
      catch { throw new BlackboardError('NETWORK', 'Zoom request failed or timed out.'); }
      if (opts.mode !== 'blackboard') {
        for (const cookie of response.headers.getSetCookie()) await this.jar.setCookie(cookie, url.href, { ignoreError: true });
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new BlackboardError('UPSTREAM', 'Zoom returned a redirect without a destination.');
        url = new URL(location, url);
        if ([301, 302, 303].includes(response.status)) { method = 'GET'; body = undefined; }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const code = [401, 403].includes(response.status) ? 'FORBIDDEN' : response.status === 404 ? 'NOT_FOUND' : 'UPSTREAM';
        throw new BlackboardError(code, 'Zoom could not provide this resource.', { status: response.status });
      }
      return response;
    }
    throw new BlackboardError('UPSTREAM', 'Zoom redirect limit exceeded.');
  }
}

export async function readLimited(response: Response, maxBytes = 4 * 1024 * 1024): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel(); throw new BlackboardError('BAD_INPUT', 'Zoom response exceeds the size limit.');
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (response.body) for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new BlackboardError('BAD_INPUT', 'Zoom response exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
