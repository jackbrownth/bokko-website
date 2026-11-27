// BOKKO — link previews for client portfolios.
//
// Messaging apps (iMessage, LINE, WhatsApp, Slack…) read a page's preview
// tags from the HTML exactly as the server sends it; they do not run the
// page's script. /portfolio/<code> always serves the same portfolio/index.html,
// so without this every portfolio link shows the same generic BOKKO preview.
//
// This runs on Netlify for /portfolio/<code> requests, looks the portfolio up
// in the same database the page itself reads, and writes that portfolio's own
// title, description and image into the tags before the page is sent.
//
// Preview fields come from admin > Portfolios, in this order:
//   title        Social preview title  > "BOKKO × <Prepared for>"
//   description  Social preview description > the standard line below
//   image        Social preview image > first hero image > banner image > BOKKO image
//
// If anything fails or takes too long, the page is sent exactly as it is.

const PROJECT_ID = 'bokko-6dc83';
const API_KEY = 'AIzaSyBEI6vInrFoifeHr6CLh36rZ_nw1cryzIw';   // the site's public web key, same as the page uses
const SITE = 'https://bokko.co';
const DEFAULT_IMAGE = SITE + '/og-bokko.jpg';
const DEFAULT_DESCRIPTION = 'A private proposal from BOKKO Marketing Specialists.';
const LOOKUP_TIMEOUT_MS = 3000;   // the first lookup after a quiet spell can take over 1.5 s
const CACHE_MS = 5 * 60 * 1000;
const FIELDS = ['active', 'recipient', 'metaTitle', 'ogTitle', 'ogDescription', 'ogImage', 'bannerImage', 'heroPanels'];

const cache = new Map();   // slug -> { at, value }

function slugFrom(url) {
  const q = url.searchParams.get('p');
  if (q) return q.toLowerCase().trim();
  const parts = url.pathname.split('/').filter(Boolean);
  const i = parts.indexOf('portfolio');
  if (i > -1 && parts[i + 1]) {
    try { return decodeURIComponent(parts[i + 1]).toLowerCase().trim(); } catch (e) { return ''; }
  }
  return '';
}

// Firestore's REST format wraps every value in its type.
function plain(v) {
  if (!v || typeof v !== 'object') return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(plain);
  if ('mapValue' in v) {
    const out = {}, f = v.mapValue.fields || {};
    Object.keys(f).forEach((k) => { out[k] = plain(f[k]); });
    return out;
  }
  return undefined;
}

async function lookup(slug) {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(
      'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents:runQuery?key=' + API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Referer: SITE + '/' },
        signal: ctrl.signal,
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'portfolios' }],
            where: { fieldFilter: { field: { fieldPath: 'slugLower' }, op: 'EQUAL', value: { stringValue: slug } } },
            select: { fields: FIELDS.map((f) => ({ fieldPath: f })) },
            limit: 1
          }
        })
      }
    );
    if (!res.ok) return null;                       // not cached: try again next time
    const rows = await res.json();
    const doc = Array.isArray(rows) && rows[0] && rows[0].document;
    let value = null;
    if (doc) {
      value = {};
      Object.keys(doc.fields || {}).forEach((k) => { value[k] = plain(doc.fields[k]); });
    }
    cache.set(slug, { at: Date.now(), value });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return value;
  } finally {
    clearTimeout(timer);
  }
}

function absolute(src) {
  const s = String(src || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('/')) return SITE + s;
  return SITE + '/portfolio/' + s;                  // the page resolves "media/…" against /portfolio/
}

// Preview cards are landscape. Uploaded images are often portrait, so they are
// cropped to 1200 × 630 by Netlify's image service (already enabled for the
// site's uploads in netlify.toml).
function previewImage(src) {
  const abs = absolute(src);
  if (!abs) return { url: DEFAULT_IMAGE, sized: true };
  if (abs.startsWith('https://firebasestorage.googleapis.com/')) {
    return { url: SITE + '/.netlify/images?url=' + encodeURIComponent(abs) + '&w=1200&h=630&fit=cover&fm=jpg&q=82', sized: true };
  }
  if (abs.startsWith(SITE + '/')) {
    return { url: SITE + '/.netlify/images?url=' + encodeURIComponent(abs.slice(SITE.length)) + '&w=1200&h=630&fit=cover&fm=jpg&q=82', sized: true };
  }
  return { url: abs, sized: false };
}

function attr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tagsFor(d, slug) {
  const firstPanel = (Array.isArray(d.heroPanels) ? d.heroPanels : []).find((p) => p && p.image);
  const title = (d.ogTitle || '').trim()
    || (d.recipient ? 'BOKKO × ' + String(d.recipient).trim() : '')
    || 'BOKKO — Portfolio';
  const description = (d.ogDescription || '').trim() || DEFAULT_DESCRIPTION;
  const img = previewImage(d.ogImage || (firstPanel && firstPanel.image) || d.bannerImage || '');
  return [
    '<meta property="og:title" content="' + attr(title) + '">',
    '<meta property="og:description" content="' + attr(description) + '">',
    '<meta property="og:image" content="' + attr(img.url) + '">',
    img.sized ? '<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">' : '',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="BOKKO">',
    '<meta property="og:url" content="' + attr(SITE + '/portfolio/' + encodeURIComponent(slug)) + '">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="' + attr(title) + '">',
    '<meta name="twitter:description" content="' + attr(description) + '">',
    '<meta name="twitter:image" content="' + attr(img.url) + '">'
  ].filter(Boolean).join('\n');
}

const OLD_TAGS = /[ \t]*<meta\s+(?:property|name)="(?:og:(?:title|description|image(?::width|:height)?|type|site_name|url)|twitter:(?:card|title|description|image))"[^>]*>\s*\n?/gi;

export default async function handler(request, context) {
  if (request.method !== 'GET') return context.next();
  const url = new URL(request.url);
  const slug = slugFrom(url);
  if (!slug || slug === 'media' || slug === 'index.html') return context.next();

  // Start the lookup and the page together, so the visitor does not wait twice.
  const lookupP = lookup(slug).catch(() => null);
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (response.status !== 200 || type.indexOf('text/html') === -1) return response;

  const d = await lookupP;
  if (!d || d.active === false) return response;     // unknown or switched-off portfolio: generic preview

  try {
    const html = await response.text();
    const at = html.indexOf('</head>');
    if (at === -1) return new Response(html, response);
    const head = html.slice(0, at).replace(OLD_TAGS, '');
    const out = head + tagsFor(d, slug) + '\n' + html.slice(at);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('etag');
    return new Response(out, { status: response.status, statusText: response.statusText, headers });
  } catch (e) {
    return context.next();
  }
}
