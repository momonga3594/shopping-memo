/**
 * shopping-memo flyer image proxy (Cloudflare Worker)
 * Fetches remote images server-side to bypass browser CORS.
 * Also resolves known flyer VIEWER / store pages (Aeon, Uoroku, Kurashiru, Harashin) to image URL lists.
 * No Gemini / API keys are handled here.
 */

const MAX_BYTES = 8 * 1024 * 1024; // 8 MiB
const MAX_JSON_BYTES = 2 * 1024 * 1024; // 2 MiB
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MiB
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

/** Hosts allowed for Aeon chirashi viewer resolve */
const AEON_VIEWER_HOSTS = new Set(['chirashi.otoku.aeonsquare.net']);

/** Hosts allowed for HTML resolve fetches (Uoroku / Kurashiru) */
const HTML_RESOLVE_HOSTS = new Set([
  'www.uoroku.co.jp',
  'uoroku.co.jp',
  'chirashi.kurashiru.com',
  'www.aeon.com',
  'aeon.com',
  'www.harashinnarus.jp',
  'harashinnarus.jp',
]);

const KURASHIRU_UUID_RE =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

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

    let mode;
    let targetRaw;
    try {
      ({ mode, targetRaw } = await readRequestTarget(request));
    } catch (err) {
      return jsonError(400, 'bad_request', err.message || 'url または resolve パラメータが必要です。', origin, allowed);
    }

    if (mode === 'resolve') {
      try {
        const result = await resolveViewerUrl(targetRaw);
        const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
        headers.set('Cache-Control', 'public, max-age=120');
        applyCors(headers, origin, allowed);
        return new Response(JSON.stringify(result), { status: 200, headers });
      } catch (err) {
        const code = err.code || 'resolve_failed';
        const status = err.status || 502;
        return jsonError(status, code, err.message || 'ビューアURLの解析に失敗しました。', origin, allowed);
      }
    }

    try {
      const result = await fetchImageSafely(targetRaw);
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

/**
 * Read either image proxy `url` or viewer `resolve` from query / POST body.
 * @returns {Promise<{ mode: 'image' | 'resolve', targetRaw: string }>}
 */
async function readRequestTarget(request) {
  const reqUrl = new URL(request.url);
  let resolveRaw = reqUrl.searchParams.get('resolve') || '';
  let urlRaw = reqUrl.searchParams.get('url') || '';

  if ((!resolveRaw && !urlRaw) && request.method === 'POST') {
    const ctype = (request.headers.get('Content-Type') || '').toLowerCase();
    if (ctype.includes('application/json')) {
      const body = await request.json().catch(() => null);
      resolveRaw = body?.resolve || '';
      urlRaw = body?.url || '';
    } else if (ctype.includes('application/x-www-form-urlencoded')) {
      const form = await request.formData();
      resolveRaw = String(form.get('resolve') || '');
      urlRaw = String(form.get('url') || '');
    }
  }

  resolveRaw = String(resolveRaw || '').trim();
  urlRaw = String(urlRaw || '').trim();

  if (resolveRaw) {
    return { mode: 'resolve', targetRaw: resolveRaw };
  }
  if (urlRaw) {
    return { mode: 'image', targetRaw: urlRaw };
  }
  throw new Error('url または resolve パラメータ（または JSON）が必要です。');
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
  return false;
}

function isIpLiteral(host) {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (h.includes(':')) return true;
  return false;
}

function normalizeIp(host) {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

function isBlockedIp(ipRaw) {
  const ip = normalizeIp(ipRaw).toLowerCase();

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.').map((x) => Number(x));
    if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0 && parts[2] === 0) return true;
    if (a === 192 && b === 0 && parts[2] === 2) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }

  if (ip.includes(':')) {
    if (ip === '::1' || ip === '::') return true;
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
    if (ip.startsWith('fe80')) return true;
    if (ip.startsWith('ff')) return true;
    const v4map = ip.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (v4map) return isBlockedIp(v4map[1]);
    return false;
  }

  return true;
}

async function resolveAndCheckHost(hostname) {
  const host = hostname.toLowerCase();
  if (isIpLiteral(host)) {
    if (isBlockedIp(host)) {
      throw proxyError(403, 'blocked_ip', 'プライベート／内部アドレスへのアクセスは許可されていません。');
    }
    return;
  }

  const names = await resolveDns(host);
  if (!names.length) {
    throw proxyError(502, 'dns_failed', 'ホスト名を解決できませんでした。');
  }
  for (const addr of names) {
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

/* ---------- Viewer resolve (Aeon / Uoroku / Kurashiru) ---------- */

async function resolveViewerUrl(rawViewerUrl) {
  const viewer = parseAndValidateUrl(rawViewerUrl);
  const host = viewer.hostname.toLowerCase();

  if (AEON_VIEWER_HOSTS.has(host) && viewer.pathname.includes('/viewer/')) {
    return resolveAeonViewer(viewer);
  }

  if (
    (host === 'www.uoroku.co.jp' || host === 'uoroku.co.jp') &&
    viewer.pathname.includes('/shop/flyer/')
  ) {
    return resolveUorokuFlyerPage(viewer);
  }

  if (host === 'chirashi.kurashiru.com') {
    const widgetRe = new RegExp(`^/widgets/${KURASHIRU_UUID_RE}/leaflets/?$`, 'i');
    const storeRe = new RegExp(`^/stores/${KURASHIRU_UUID_RE}(?:/|$)`, 'i');
    if (widgetRe.test(viewer.pathname)) {
      return resolveKurashiruWidget(viewer);
    }
    if (storeRe.test(viewer.pathname)) {
      return resolveKurashiruStore(viewer);
    }
  }

  if ((host === 'www.aeon.com' || host === 'aeon.com') && isAeonStorePath(viewer.pathname)) {
    return resolveAeonStorePage(viewer);
  }

  if (
    (host === 'www.harashinnarus.jp' || host === 'harashinnarus.jp') &&
    isHarashinShopPath(viewer.pathname)
  ) {
    return resolveHarashinShopPage(viewer);
  }

  throw proxyError(
    400,
    'unsupported_viewer',
    'このビューアURLには未対応です。イオン店舗／チラシビューア、ウオロク店舗チラシ、クラシル、原信店舗のURL、または画像の直リンクを指定してください。',
  );
}

/** Aeon STORE page (www.aeon.com/store/...), not the chirashi viewer. */
function isAeonStorePath(pathname) {
  return /^\/store\/[^/].+/i.test(pathname || '') && !String(pathname).includes('..');
}

/** Harashin / Narus shop page, e.g. /shops/kurosaki/ */
function isHarashinShopPath(pathname) {
  return /^\/shops\/[a-z0-9_-]+\/?$/i.test(pathname || '');
}

async function resolveAeonViewer(viewerUrl) {
  const sId = String(viewerUrl.searchParams.get('s_id') || '').trim();
  let fId = String(viewerUrl.searchParams.get('f_id') || '').trim();

  if (!sId || !/^\d+$/.test(sId) || sId.length < 7) {
    throw proxyError(
      400,
      'missing_params',
      'ビューアURLに店舗ID（s_id）がありません。URLを確認するか、写真から追加してください。',
    );
  }
  if (!fId) {
    throw proxyError(
      400,
      'missing_params',
      'ビューアURLにチラシID（f_id）がありません。URLを確認するか、写真から追加してください。',
    );
  }

  // f_id may be "f176358" or "176358"
  const fidNum = fId.replace(/^f/i, '');
  if (!/^\d+$/.test(fidNum)) {
    throw proxyError(
      400,
      'missing_params',
      'チラシID（f_id）の形式が正しくありません。写真から追加してください。',
    );
  }

  // s_id "0000021780" → "0021780.json" (substr from index 3, length 7)
  const jsonId = sId.substring(3, 10);
  if (!/^\d{7}$/.test(jsonId)) {
    throw proxyError(
      400,
      'missing_params',
      '店舗ID（s_id）の形式が正しくありません。写真から追加してください。',
    );
  }

  const host = viewerUrl.hostname.toLowerCase();
  const jsonUrl = `https://${host}/viewer/json/${jsonId}.json`;
  assertAeonJsonAllowlisted(jsonUrl);

  const shop = await fetchJsonSafely(jsonUrl);
  const fliers = shop?.fliers;
  if (!fliers || typeof fliers !== 'object') {
    throw proxyError(404, 'flyer_not_found', '店舗のチラシ情報が見つかりませんでした。写真から追加してください。');
  }

  const keyRe = new RegExp(`^f${fidNum}(?:-|$)`, 'i');
  /** @type {{ key: string, entry: Record<string, unknown> }[]} */
  const matched = [];
  for (const [key, entry] of Object.entries(fliers)) {
    if (!entry || typeof entry !== 'object') continue;
    const entryFid = String(entry.fid ?? '').replace(/^f/i, '');
    if (keyRe.test(key) || entryFid === fidNum) {
      matched.push({ key, entry });
    }
  }

  if (!matched.length) {
    throw proxyError(
      404,
      'flyer_not_found',
      '指定のチラシが見つかりませんでした。URLを確認するか、写真から追加してください。',
    );
  }

  matched.sort((a, b) => {
    const na = Number(a.entry.no) || 0;
    const nb = Number(b.entry.no) || 0;
    if (na !== nb) return na - nb;
    return a.key.localeCompare(b.key);
  });

  const imageBase = `https://${host}/viewer/images/`;
  const images = [];
  const seen = new Set();
  let title = '';

  for (const { entry } of matched) {
    if (!title && entry.title) title = String(entry.title);
    const list = Array.isArray(entry.images) ? entry.images : [];
    for (const filename of list) {
      const name = String(filename || '').trim();
      if (!name || name.includes('/') || name.includes('..')) continue;
      if (!/\.(jpe?g|png|gif|webp)$/i.test(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const url = `${imageBase}${name}`;
      const thumbUrl = toAeonThumbUrl(imageBase, name);
      images.push({
        url,
        thumbUrl,
        label: `${images.length + 1}枚目`,
      });
    }
  }

  if (!images.length) {
    throw proxyError(
      404,
      'flyer_not_found',
      'チラシ画像が見つかりませんでした。写真から追加してください。',
    );
  }

  if (!title && shop.name) title = String(shop.name);

  return {
    source: 'aeon',
    title: title || '',
    shopName: shop.name ? String(shop.name) : '',
    images,
  };
}

function assertAeonJsonAllowlisted(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw proxyError(400, 'invalid_url', 'JSON URLが不正です。');
  }
  const host = u.hostname.toLowerCase();
  if (!AEON_VIEWER_HOSTS.has(host)) {
    throw proxyError(403, 'blocked_host', 'このホストのJSON取得は許可されていません。');
  }
  if (!/^\/viewer\/json\/\d{7}\.json$/i.test(u.pathname)) {
    throw proxyError(403, 'blocked_path', 'このパスのJSON取得は許可されていません。');
  }
}

function toAeonThumbUrl(imageBase, filename) {
  const m = filename.match(/^(.*)(\.[^.]+)$/);
  if (!m) return undefined;
  return `${imageBase}${m[1]}.t${m[2]}`;
}

function decodeBasicHtmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Prefer full JPEG: strip thumbnail_ / compressed_ from the filename.
 * @param {string} imageUrl
 */
function kurashiruPreferFullImageUrl(imageUrl) {
  try {
    const u = new URL(imageUrl);
    const parts = u.pathname.split('/');
    const file = parts[parts.length - 1] || '';
    const cleaned = file.replace(/^(?:thumbnail_|compressed_)/i, '');
    if (cleaned && cleaned !== file) {
      parts[parts.length - 1] = cleaned;
      u.pathname = parts.join('/');
    }
    return u.href;
  } catch {
    return String(imageUrl || '').replace(
      /\/(thumbnail_|compressed_)([^/?#]+)$/i,
      '/$2',
    );
  }
}

function assertHtmlResolveAllowlisted(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw proxyError(400, 'invalid_url', 'HTML URLが不正です。');
  }
  const host = u.hostname.toLowerCase();
  if (!HTML_RESOLVE_HOSTS.has(host)) {
    throw proxyError(403, 'blocked_host', 'このホストのHTML取得は許可されていません。');
  }
  const path = u.pathname || '';
  if (host === 'www.uoroku.co.jp' || host === 'uoroku.co.jp') {
    if (!path.includes('/shop/flyer/')) {
      throw proxyError(403, 'blocked_path', 'このパスのHTML取得は許可されていません。');
    }
    return;
  }
  if (host === 'www.aeon.com' || host === 'aeon.com') {
    if (!isAeonStorePath(path)) {
      throw proxyError(403, 'blocked_path', 'このパスのHTML取得は許可されていません。');
    }
    return;
  }
  if (host === 'www.harashinnarus.jp' || host === 'harashinnarus.jp') {
    if (!isHarashinShopPath(path)) {
      throw proxyError(403, 'blocked_path', 'このパスのHTML取得は許可されていません。');
    }
    return;
  }
  // chirashi.kurashiru.com
  const widgetRe = new RegExp(`^/widgets/${KURASHIRU_UUID_RE}/leaflets/?$`, 'i');
  const storeRe = new RegExp(`^/stores/${KURASHIRU_UUID_RE}(?:/|$)`, 'i');
  if (!widgetRe.test(path) && !storeRe.test(path)) {
    throw proxyError(403, 'blocked_path', 'このパスのHTML取得は許可されていません。');
  }
}

async function fetchHtmlSafely(rawUrl) {
  let current = parseAndValidateUrl(rawUrl);
  assertHtmlResolveAllowlisted(current.href);
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
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en;q=0.8',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') {
        throw proxyError(504, 'timeout', 'チラシページの取得がタイムアウトしました。');
      }
      throw proxyError(502, 'fetch_failed', 'チラシページの取得に失敗しました。');
    }
    clearTimeout(timer);

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
      assertHtmlResolveAllowlisted(current.href);
      await resolveAndCheckHost(current.hostname);
      continue;
    }

    if (!res.ok) {
      throw proxyError(
        502,
        'upstream_error',
        `チラシページがエラーを返しました（HTTP ${res.status}）。`,
      );
    }

    const buf = await readBodyLimited(res, MAX_HTML_BYTES);
    return new TextDecoder('utf-8').decode(buf);
  }

  throw proxyError(502, 'too_many_redirects', 'リダイレクトが多すぎます。');
}

/**
 * Uoroku store flyer page → extract Kurashiru widget iframe → resolve leaflets.
 * @param {URL} viewerUrl
 */
async function resolveUorokuFlyerPage(viewerUrl) {
  const html = await fetchHtmlSafely(viewerUrl.href);
  const widgetRe = new RegExp(
    `https://chirashi\\.kurashiru\\.com/widgets/(${KURASHIRU_UUID_RE})/leaflets`,
    'i',
  );
  const m = html.match(widgetRe);
  if (!m) {
    throw proxyError(
      404,
      'flyer_not_found',
      'ウオロク店舗ページからクラシルウィジェットを見つけられませんでした。URLを確認するか、写真から追加してください。',
    );
  }
  const widgetUrl = new URL(
    `https://chirashi.kurashiru.com/widgets/${m[1]}/leaflets`,
  );
  const result = await resolveKurashiruWidget(widgetUrl);

  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const shopName = h1 ? decodeBasicHtmlEntities(h1[1]).trim() : '';
  if (shopName) {
    result.shopName = shopName;
    if (!result.title) result.title = shopName;
  }
  return result;
}

/**
 * www.aeon.com store page → data-flyer-id (shop s_id) → current chirashi images.
 * The listing iframe is filled by JS; the shop id is in the static HTML.
 * @param {URL} pageUrl
 */
async function resolveAeonStorePage(pageUrl) {
  const html = await fetchHtmlSafely(pageUrl.href);
  const shopId = extractAeonShopId(html);
  if (!shopId) {
    throw proxyError(
      404,
      'flyer_not_found',
      'イオン店舗ページからチラシの店舗IDを見つけられませんでした。URLを確認するか、写真から追加してください。',
    );
  }
  return resolveAeonShopCurrentFlyers(shopId);
}

/**
 * Shop id from Aeon STORE HTML (`data-flyer-id` or a chirashi shop_id link).
 * @param {string} html
 */
function extractAeonShopId(html) {
  const text = decodeBasicHtmlEntities(html);
  /** @type {string[]} */
  const ids = [];
  const attrRe = /data-flyer-id=["'](\d{7,12})["']/gi;
  let m;
  while ((m = attrRe.exec(text)) !== null) ids.push(m[1]);
  const shopRe =
    /chirashi\.otoku\.aeonsquare\.net[^"'<\s]*[?&]shop_id=(\d{7,12})\b/gi;
  while ((m = shopRe.exec(text)) !== null) ids.push(m[1]);
  if (!ids.length) return '';
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  let best = '';
  let bestN = 0;
  for (const [id, n] of counts) {
    if (n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

/**
 * All pages of flyers whose start/end (JST) include now.
 * Same date window as chirashi.otoku listing (`showFlier`).
 * @param {string} shopId
 */
async function resolveAeonShopCurrentFlyers(shopId) {
  const jsonId = shopId.substring(3, 10);
  if (!/^\d+$/.test(shopId) || shopId.length < 7 || !/^\d{7}$/.test(jsonId)) {
    throw proxyError(
      400,
      'missing_params',
      '店舗ID（s_id）の形式が正しくありません。写真から追加してください。',
    );
  }
  const jsonUrl = `https://chirashi.otoku.aeonsquare.net/viewer/json/${jsonId}.json`;
  const shop = await fetchJsonSafely(jsonUrl);
  const fliers = shop?.fliers;
  if (!fliers || typeof fliers !== 'object') {
    throw proxyError(
      404,
      'flyer_not_found',
      '店舗のチラシ情報が見つかりませんでした。写真から追加してください。',
    );
  }

  const now = Date.now();
  /** @type {Record<string, unknown>[]} */
  const current = [];
  for (const entry of Object.values(fliers)) {
    if (!entry || typeof entry !== 'object') continue;
    if (!isAeonFlierCurrent(entry, now)) continue;
    current.push(entry);
  }

  const images = collectAeonImages('chirashi.otoku.aeonsquare.net', current);
  if (!images.length) {
    throw proxyError(
      404,
      'flyer_not_found',
      'いま掲載中のチラシが見つかりませんでした。写真から追加してください。',
    );
  }

  const shopName = shop.name ? String(shop.name) : '';
  const onlyTitle =
    current.length === 1 && current[0].title ? String(current[0].title) : '';
  return {
    source: 'aeon',
    title: onlyTitle || shopName,
    shopName,
    images,
  };
}

/**
 * @param {string} dateStr "YYYY-MM-DD HH:mm:ss" interpreted as JST
 * @returns {number | null}
 */
function parseAeonJstMs(dateStr) {
  const m = String(dateStr || '').match(
    /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/,
  );
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}+09:00`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function isAeonFlierCurrent(entry, nowMs) {
  const start = parseAeonJstMs(entry.start);
  const end = parseAeonJstMs(entry.end);
  if (start == null || end == null) return false;
  return nowMs >= start && nowMs <= end;
}

/**
 * @param {string} host
 * @param {Record<string, unknown>[]} entries
 */
function collectAeonImages(host, entries) {
  const imageBase = `https://${host}/viewer/images/`;
  /** @type {{ url: string, thumbUrl?: string, label: string }[]} */
  const images = [];
  const seen = new Set();
  for (const entry of entries) {
    const list = Array.isArray(entry.images) ? entry.images : [];
    /** @type {string[]} */
    const valid = [];
    for (const filename of list) {
      const name = String(filename || '').trim();
      if (!name || name.includes('/') || name.includes('..')) continue;
      if (!/\.(jpe?g|png|gif|webp)$/i.test(name)) continue;
      if (seen.has(name)) continue;
      valid.push(name);
    }
    const flyerTitle = entry.title ? String(entry.title) : '';
    valid.forEach((name, idx) => {
      seen.add(name);
      let label;
      if (flyerTitle && valid.length > 1) label = `${flyerTitle} ${idx + 1}枚目`;
      else if (flyerTitle) label = flyerTitle;
      else label = `${images.length + 1}枚目`;
      const url = `${imageBase}${name}`;
      images.push({
        url,
        thumbUrl: toAeonThumbUrl(imageBase, name),
        label,
      });
    });
  }
  return images;
}

/**
 * Harashin shop page: flyer JPEGs are in the static HTML (registeredStore02).
 * @param {URL} pageUrl
 */
async function resolveHarashinShopPage(pageUrl) {
  const html = await fetchHtmlSafely(pageUrl.href);
  const images = parseHarashinShopFlyers(html);
  if (!images.length) {
    throw proxyError(
      404,
      'flyer_not_found',
      '原信店舗ページからチラシ画像が見つかりませんでした。URLを確認するか、写真から追加してください。',
    );
  }
  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const shopName = h1 ? decodeBasicHtmlEntities(h1[1]).trim() : '';
  return {
    source: 'harashin',
    title: shopName || images[0].label,
    shopName,
    images,
  };
}

/**
 * @param {string} html
 * @returns {{ url: string, label: string }[]}
 */
function parseHarashinShopFlyers(html) {
  /** @type {{ url: string, label: string }[]} */
  const images = [];
  const seen = new Set();
  const liRe =
    /<li\b[^>]*class="[^"]*registeredStore02__single[^"]*"[\s\S]*?<\/li>/gi;
  let li;
  while ((li = liRe.exec(html)) !== null) {
    const block = li[0];
    const numMatch = block.match(/class="num"[^>]*>([^<]*)</i);
    const groupTitle = numMatch ? decodeBasicHtmlEntities(numMatch[1]).trim() : '';
    const flyerDivRe =
      /<div\b[^>]*class="[^"]*\bflyer\d*\b[^"]*"[^>]*>\s*(<img\b[^>]*>)/gi;
    /** @type {{ src: string, alt: string }[]} */
    const found = [];
    let fd;
    while ((fd = flyerDivRe.exec(block)) !== null) {
      const tag = fd[1];
      const srcM = tag.match(/\bsrc="([^"]+)"/i);
      if (!srcM) continue;
      const altM = tag.match(/\balt="([^"]*)"/i);
      found.push({
        src: decodeBasicHtmlEntities(srcM[1]),
        alt: altM ? decodeBasicHtmlEntities(altM[1]).trim() : '',
      });
    }
    found.forEach((img, idx) => {
      let abs;
      try {
        abs = new URL(img.src, 'https://www.harashinnarus.jp/');
      } catch {
        return;
      }
      const host = abs.hostname.toLowerCase();
      if (host !== 'www.harashinnarus.jp' && host !== 'harashinnarus.jp') return;
      if (!/\/hnhp_wp\/wp-content\/uploads\//i.test(abs.pathname)) return;
      if (!/\.(jpe?g|png|gif|webp)$/i.test(abs.pathname)) return;
      if (seen.has(abs.href)) return;
      seen.add(abs.href);
      const base = groupTitle || img.alt || '';
      let label;
      if (found.length === 2 && base) label = `${base}（${idx === 0 ? '表' : '裏'}）`;
      else if (found.length > 1 && base) label = `${base} ${idx + 1}枚目`;
      else label = base || `${images.length + 1}枚目`;
      images.push({ url: abs.href, label });
    });
  }
  return images;
}

/**
 * @param {URL} viewerUrl
 */
async function resolveKurashiruWidget(viewerUrl) {
  const html = await fetchHtmlSafely(viewerUrl.href);
  const images = parseKurashiruWidgetLeaflets(html);
  if (!images.length) {
    throw proxyError(
      404,
      'flyer_not_found',
      'クラシルウィジェットからチラシ画像が見つかりませんでした。URLを確認するか、写真から追加してください。',
    );
  }
  const title = images[0]?.label && !/^\d+枚目$/.test(images[0].label) ? images[0].label : '';
  return {
    source: 'kurashiru',
    title: title || '',
    shopName: '',
    images,
  };
}

/**
 * @param {URL} viewerUrl
 */
async function resolveKurashiruStore(viewerUrl) {
  const html = await fetchHtmlSafely(viewerUrl.href);
  const images = parseKurashiruStoreLeaflets(html);
  if (!images.length) {
    // Fallback: some store pages may still embed widget-like markup
    const fallback = parseKurashiruWidgetLeaflets(html);
    if (!fallback.length) {
      throw proxyError(
        404,
        'flyer_not_found',
        'クラシル店舗ページからチラシ画像が見つかりませんでした。URLを確認するか、写真から追加してください。',
      );
    }
    return {
      source: 'kurashiru',
      title: fallback[0]?.label && !/^\d+枚目$/.test(fallback[0].label) ? fallback[0].label : '',
      shopName: '',
      images: fallback,
    };
  }
  const title = images[0]?.label && !/^\d+枚目$/.test(images[0].label) ? images[0].label : '';
  return {
    source: 'kurashiru',
    title: title || '',
    shopName: '',
    images,
  };
}

/**
 * Parse LeafletCarouselWidget anchors from Kurashiru widget HTML.
 * @param {string} html
 * @returns {{ url: string, thumbUrl?: string, label: string }[]}
 */
function parseKurashiruWidgetLeaflets(html) {
  /** @type {{ url: string, thumbUrl?: string, label: string }[]} */
  const images = [];
  const seen = new Set();
  const anchorRe =
    /<a\b[^>]*\bdata-leaflet-id="(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    const block = m[2];
    const thumbMatch = block.match(
      /src="(https:\/\/video\.kurashiru\.com\/production\/chirashiru_leaflet\/image\/\d+\/[^"]+)"/i,
    );
    if (!thumbMatch) continue;
    const thumbUrl = decodeBasicHtmlEntities(thumbMatch[1]);
    const fullUrl = kurashiruPreferFullImageUrl(thumbUrl);

    let label = '';
    const titleMatch = block.match(
      /LeafletCarouselWidget-leafletTitle[^>]*>([^<]*)</i,
    );
    if (titleMatch) label = decodeBasicHtmlEntities(titleMatch[1]).trim();
    if (!label) {
      const altMatch = block.match(/\balt="([^"]*)"/i);
      if (altMatch) label = decodeBasicHtmlEntities(altMatch[1]).trim();
    }
    if (!label) label = `${images.length + 1}枚目`;

    seen.add(id);
    images.push({ url: fullUrl, thumbUrl, label });
  }
  return images;
}

/**
 * Parse StoresShowLimitExcursion leaflet items from Kurashiru store HTML.
 * @param {string} html
 * @returns {{ url: string, thumbUrl?: string, label: string }[]}
 */
function parseKurashiruStoreLeaflets(html) {
  /** @type {{ url: string, thumbUrl?: string, label: string }[]} */
  const images = [];
  const seen = new Set();
  // data-leaflet-id then nearby chirashiru_leaflet image src (+ optional alt)
  const itemRe =
    /data-leaflet-id="(\d+)"[\s\S]{0,1500}?src="(https:\/\/video\.kurashiru\.com\/production\/chirashiru_leaflet\/image\/\1\/[^"]+)"/gi;
  let m;
  while ((m = itemRe.exec(html)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    const src = decodeBasicHtmlEntities(m[2]);
    const fullUrl = kurashiruPreferFullImageUrl(src);
    // Prefer keeping a thumbnail_/compressed_ variant as thumb when present
    const thumbUrl = /\/(?:thumbnail_|compressed_)/i.test(src) ? src : undefined;

    let label = '';
    // Look slightly before the match for alt on the same img (alt may precede src)
    const windowStart = Math.max(0, m.index - 200);
    const around = html.slice(windowStart, m.index + m[0].length + 50);
    const altMatch = around.match(
      new RegExp(
        `alt="([^"]*)"[\\s\\S]{0,400}?src="${escapeRegExp(m[2])}"|src="${escapeRegExp(m[2])}"[\\s\\S]{0,200}?alt="([^"]*)"`,
        'i',
      ),
    );
    if (altMatch) label = decodeBasicHtmlEntities(altMatch[1] || altMatch[2] || '').trim();
    // Strip common brand prefix like "ウオロク "
    if (label) label = label.replace(/^ウオロク\s+/, '').trim() || label;
    if (!label) label = `${images.length + 1}枚目`;

    seen.add(id);
    images.push({ url: fullUrl, thumbUrl, label });
  }
  return images;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchJsonSafely(rawUrl) {
  let current = parseAndValidateUrl(rawUrl);
  assertAeonJsonAllowlisted(current.href);
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
          Accept: 'application/json,text/plain,*/*;q=0.8',
          'Accept-Language': 'ja,en;q=0.8',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') {
        throw proxyError(504, 'timeout', 'チラシ情報の取得がタイムアウトしました。');
      }
      throw proxyError(502, 'fetch_failed', 'チラシ情報の取得に失敗しました。');
    }
    clearTimeout(timer);

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
      assertAeonJsonAllowlisted(current.href);
      await resolveAndCheckHost(current.hostname);
      continue;
    }

    if (!res.ok) {
      throw proxyError(
        502,
        'upstream_error',
        `チラシ情報サーバーがエラーを返しました（HTTP ${res.status}）。`,
      );
    }

    const buf = await readBodyLimited(res, MAX_JSON_BYTES);
    const text = new TextDecoder('utf-8').decode(buf);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw proxyError(502, 'invalid_json', 'チラシ情報の形式が不正です。');
    }
    return data;
  }

  throw proxyError(502, 'too_many_redirects', 'リダイレクトが多すぎます。');
}

/* ---------- Image proxy ---------- */

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
    const buf = await readBodyLimited(res, MAX_BYTES);
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

async function readBodyLimited(res, maxBytes = MAX_BYTES) {
  const len = Number(res.headers.get('Content-Length') || 0);
  if (len && len > maxBytes) {
    throw proxyError(413, 'too_large', '応答が大きすぎます。');
  }

  const reader = res.body?.getReader();
  if (!reader) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      throw proxyError(413, 'too_large', '応答が大きすぎます。');
    }
    return new Uint8Array(ab);
  }

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        reader.cancel();
      } catch {
        /* ignore */
      }
      throw proxyError(413, 'too_large', '応答が大きすぎます。');
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
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
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
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
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
