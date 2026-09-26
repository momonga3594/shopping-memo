/**
 * shopping-memo flyer image proxy (Cloudflare Worker)
 * Fetches remote images server-side to bypass browser CORS.
 * No Gemini / API keys are handled here.
 */

const MAX_BYTES = 8 * 1024 * 1024; // 8 MiB
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; ShoppingMemoFlyerProxy/1.0; +https://github.com/momonga3594/shopping-memo)';

const DEFAULT_ALLOWED_ORIGINS = [
  'https://momonga3594.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = getAllowedOrigins(env);

    if (request.method === 'OPTIONS') {
      return corsPreflight(origin, allowed);
    }

    if (request.method !== 'GET' && request.method !== 'POST') {
      return jsonError(405, 'method_not_allowed', 'GET または POST のみ対応です。', origin, allowed);
    }

    if (env.PROXY_SECRET) {
      const provided = request.headers.get('X-Proxy-Secret') || '';
      if (provided !== env.PROXY_SECRET) {
        return jsonError(401, 'unauthorized', 'プロキシ認証に失敗しました。', origin, allowed);
      }
    }

    let targetUrl;
    try {
      targetUrl = await readTargetUrl(request);
    } catch (err) {
      return jsonError(400, 'bad_request', err.message || 'url パラメータが必要です。', origin, allowed);
    }

    try {
      const result = await fetchImageSafely(targetUrl);
      const headers = new Headers();
      headers.set('Content-Type', result.contentType);
      headers.set('Cache-Control', 'public, max-age=300');
      headers.set('X-Content-Type-Options', 'nosniff');
      applyCors(headers, origin, allowed);
      return new Response(result.body, { status: 200, headers });
    } catch (err) {
      const code = err.code || 'fetch_failed';
      const status = err.status || 502;
      return jsonError(status, code, err.message || '画像の取得に失敗しました。', origin, allowed);
    }
  },
};

function getAllowedOrigins(env) {
  if (env?.ALLOWED_ORIGINS) {
    return String(env.ALLOWED_ORIGINS)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

function applyCors(headers, origin, allowed) {
  if (origin && allowed.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  } else if (!origin) {
    // non-browser clients (curl) — no ACAO needed
  }
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Proxy-Secret',
  );
  headers.set('Access-Control-Max-Age', '86400');
}

function corsPreflight(origin, allowed) {
  const headers = new Headers();
  applyCors(headers, origin, allowed);
  if (origin && !allowed.includes(origin)) {
    return new Response(null, { status: 403, headers });
  }
  return new Response(null, { status: 204, headers });
}

function jsonError(status, code, message, origin, allowed) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  applyCors(headers, origin, allowed);
  return new Response(JSON.stringify({ error: code, message }), { status, headers });
}

async function readTargetUrl(request) {
  const reqUrl = new URL(request.url);
  let raw = reqUrl.searchParams.get('url') || '';

  if (!raw && request.method === 'POST') {
    const ctype = (request.headers.get('Content-Type') || '').toLowerCase();
    if (ctype.includes('application/json')) {
      const body = await request.json().catch(() => null);
      raw = body?.url || '';
    } else if (ctype.includes('application/x-www-form-urlencoded')) {
      const form = await request.formData();
      raw = String(form.get('url') || '');
    }
  }

  raw = String(raw || '').trim();
  if (!raw) {
    throw new Error('url パラメータ（または JSON の url）が必要です。');
  }
  return raw;
}

function proxyError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Validate URL string: scheme + host policy. Returns URL object.
 */
function parseAndValidateUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw proxyError(400, 'invalid_url', 'URLの形式が正しくありません。');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw proxyError(400, 'invalid_scheme', 'http または https のURLのみ許可されています。');
  }
  if (u.username || u.password) {
    throw proxyError(400, 'invalid_url', '認証情報付きURLは許可されていません。');
  }
  const host = u.hostname.toLowerCase();
  if (!host) {
    throw proxyError(400, 'invalid_url', 'ホスト名がありません。');
  }
  if (isBlockedHostname(host)) {
    throw proxyError(403, 'blocked_host', 'このホストへのアクセスは許可されていません。');
  }
  if (isIpLiteral(host) && isBlockedIp(host)) {
    throw proxyError(403, 'blocked_ip', 'プライベート／内部アドレスへのアクセスは許可されていません。');
  }
  return u;
}

function isBlockedHostname(host) {
  if (host === 'localhost' || host === 'localhost.') return true;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.endsWith('.internal') || host.endsWith('.intranet')) return true;
  if (host.endsWith('.lan') || host.endsWith('.home') || host.endsWith('.corp')) return true;
  if (host === 'metadata.google.internal') return true;
  if (host === '0' || host === '0.0.0.0') return true;
  // IPv6 localhost forms without brackets already handled as literals
  return false;
}

function isIpLiteral(host) {
  // Strip IPv6 brackets
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (h.includes(':')) return true; // rough IPv6
  return false;
}

function normalizeIp(host) {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

function isBlockedIp(ipRaw) {
  const ip = normalizeIp(ipRaw).toLowerCase();

  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.').map((x) => Number(x));
    if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 192 && b === 0 && parts[2] === 0) return true;
    if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  // IPv6
  if (ip.includes(':')) {
    if (ip === '::1' || ip === '::') return true;
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // ULA fc00::/7
    if (ip.startsWith('fe80')) return true; // link-local
    if (ip.startsWith('ff')) return true; // multicast
    // IPv4-mapped
    const v4map = ip.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (v4map) return isBlockedIp(v4map[1]);
    // unique local / documentation roughly covered
    return false;
  }

  return true; // unknown form → block
}

async function resolveAndCheckHost(hostname) {
  const host = hostname.toLowerCase();
  if (isIpLiteral(host)) {
    if (isBlockedIp(host)) {
      throw proxyError(403, 'blocked_ip', 'プライベート／内部アドレスへのアクセスは許可されていません。');
    }
    return;
  }

  // Resolve via Cloudflare DoH
  const names = await resolveDns(host);
  if (!names.length) {
    throw proxyError(502, 'dns_failed', 'ホスト名を解決できませんでした。');
  }
  for (const addr of names) {
    // Skip non-IP strings defensively (e.g. unexpected DoH data).
    if (!isIpLiteral(addr)) continue;
    if (isBlockedIp(addr)) {
      throw proxyError(
        403,
        'blocked_ip',
        '解決先がプライベート／内部アドレスのため拒否しました。',
      );
    }
  }
}

async function resolveDns(hostname) {
  const results = [];
  // DoH may include CNAME (type 5) in the Answer section alongside A/AAAA.
  // Only treat actual address records as IPs; CNAME hostnames are not IPs.
  const wantType = { A: 1, AAAA: 28 };
  for (const type of ['A', 'AAAA']) {
    const doh = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;
    try {
      const res = await fetch(doh, {
        headers: { Accept: 'application/dns-json' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const ans of data.Answer || []) {
        if (ans.type !== wantType[type]) continue;
        if (typeof ans.data === 'string') results.push(ans.data);
      }
    } catch {
      /* ignore individual type failures */
    }
  }
  return results;
}

async function fetchImageSafely(rawUrl) {
  let current = parseAndValidateUrl(rawUrl);
  await resolveAndCheckHost(current.hostname);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'Accept-Language': 'ja,en;q=0.8',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') {
        throw proxyError(504, 'timeout', '画像の取得がタイムアウトしました。');
      }
      throw proxyError(502, 'fetch_failed', '画像の取得に失敗しました。');
    }
    clearTimeout(timer);

    // Redirects
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('Location');
      if (!loc) {
        throw proxyError(502, 'bad_redirect', 'リダイレクト先がありません。');
      }
      if (hop === MAX_REDIRECTS) {
        throw proxyError(502, 'too_many_redirects', 'リダイレクトが多すぎます。');
      }
      let next;
      try {
        next = new URL(loc, current);
      } catch {
        throw proxyError(502, 'bad_redirect', 'リダイレクトURLが不正です。');
      }
      current = parseAndValidateUrl(next.href);
      await resolveAndCheckHost(current.hostname);
      continue;
    }

    if (!res.ok) {
      throw proxyError(502, 'upstream_error', `画像サーバーがエラーを返しました（HTTP ${res.status}）。`);
    }

    const headerType = (res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    const buf = await readBodyLimited(res);
    const sniffed = sniffImageMime(buf);
    const contentType = sniffed || (headerType.startsWith('image/') ? headerType : '');

    if (!contentType) {
      throw proxyError(
        415,
        'not_image',
        '応答が画像ではありません。画像の直リンクを指定してください。',
      );
    }

    return { body: buf, contentType };
  }

  throw proxyError(502, 'too_many_redirects', 'リダイレクトが多すぎます。');
}

async function readBodyLimited(res) {
  const len = Number(res.headers.get('Content-Length') || 0);
  if (len && len > MAX_BYTES) {
    throw proxyError(413, 'too_large', '画像が大きすぎます（上限 8MB）。');
  }

  const reader = res.body?.getReader();
  if (!reader) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_BYTES) {
      throw proxyError(413, 'too_large', '画像が大きすぎます（上限 8MB）。');
    }
    return new Uint8Array(ab);
  }

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try {
        reader.cancel();
      } catch {
        /* ignore */
      }
      throw proxyError(413, 'too_large', '画像が大きすぎます（上限 8MB）。');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 12) return null;
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // PNG
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  // GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  // WEBP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // BMP
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  // AVIF / HEIC (ftyp)
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) {
      return 'image/heic';
    }
  }
  return null;
}
