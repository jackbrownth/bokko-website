#!/usr/bin/env node
/* BOKKO — bake saved admin content into the static pages, in English and Thai.
 *
 * Why: the homepage and advisory page draw their content with JavaScript from
 * the admin database. AI crawlers (ChatGPT, Claude, Perplexity…) do not run
 * JavaScript, so without this they see pages with no headline and no text.
 * This script opens each page the way a browser would, lets the page's own
 * code draw the saved content, and writes the result into the HTML files:
 *
 *     index.html      → index.html (English, baked)  +  th/index.html (Thai)
 *     advisory.html   → advisory.html (baked)        +  th/advisory.html (Thai)
 *     client work     → case-studies/<name>/         +  th/case-studies/<name>/
 *                       (for the clients listed in CASE_STUDY_PAGES in index.html)
 *
 * Visitors see no difference: each page still loads the latest content on top.
 *
 * Run it before every deploy, and after editing content or Thai text in admin:
 *     npm install          (first time only)
 *     node prerender.js
 *     netlify deploy --prod
 */
const fs = require('fs');
const path = require('path');

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require('jsdom')); }
catch (e) { console.error('prerender needs the "jsdom" package. Run this once in the site folder:\n\n    npm install\n'); process.exit(1); }

const ROOT = __dirname;
const PROJECT = 'bokko-6dc83';
const SITE = 'https://bokko.co';
const PAGES = [
  { src: 'index.html', th: 'th/index.html', enUrl: '/', thUrl: '/th/',
    slots: ['heroContent', 'statsRow', 'servicesHead', 'servicesGrid', 'pricingHead', 'priceGrid', 'caseHead', 'caseTrack', 'cards', 'igHead', 'trustedHead'] },
  { src: 'advisory.html', th: 'th/advisory.html', enUrl: '/advisory.html', thUrl: '/th/advisory.html',
    slots: ['bannerOverlay', 'heroContent', 'statsRow', 'areasHead', 'advisoryGrid', 'whyBokko', 'bioContent', 'ctaContent'] },
];

/* ---------- read the saved content straight from Firestore ---------- */
function fromFirestore(v) {
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromFirestore(x)]));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestore);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  return 'stringValue' in v ? v.stringValue : Object.values(v)[0];
}
const plain = doc => fromFirestore({ mapValue: { fields: doc.fields || {} } });
const API = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

async function loadEverything() {
  const content = {};
  for (const name of ['siteCopy', 'caseStudies', 'logos', 'testimonials', 'branding', 'advisory', 'th_dict']) {
    const res = await fetch(`${API}/content/${name}`);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`Firestore answered ${res.status} for content/${name}`);
    content[name] = plain(await res.json());
  }
  let projects = [], token = '';
  do {
    const res = await fetch(`${API}/projects?pageSize=300${token ? '&pageToken=' + token : ''}`);
    if (!res.ok) throw new Error(`Firestore answered ${res.status} for projects`);
    const page = await res.json();
    projects = projects.concat((page.documents || []).map(plain));
    token = page.nextPageToken || '';
  } while (token);
  projects.sort((a, b) => (a.order || 0) - (b.order || 0));
  return { content, projects };
}

/* A stand-in for the Firebase library that answers from the data fetched above. */
function fakeFirebase(data) {
  const docSnap = d => ({ exists: !!d, data: () => d });
  const db = {
    collection(name) {
      const col = {
        orderBy: () => col,
        get: async () => {
          const rows = name === 'projects' ? data.projects : [];
          return { empty: !rows.length, docs: rows.map(r => ({ data: () => r })) };
        },
        doc: id => ({ get: async () => docSnap(name === 'content' ? data.content[id] : undefined) }),
      };
      return col;
    },
  };
  return { initializeApp() {}, firestore: () => db };
}

/* ---------- draw one page in one language and collect what it drew ---------- */
async function draw(html, page, lang, data, scripts) {
  const quiet = new VirtualConsole(); // page console noise is not interesting here
  const errors = [];
  quiet.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(html, {
    url: SITE + (lang === 'th' ? page.thUrl : page.enUrl),
    runScripts: 'dangerously', virtualConsole: quiet,
    beforeParse(window) {
      window.firebase = fakeFirebase(data);
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      window.HTMLMediaElement.prototype.play = () => Promise.resolve();
      window.HTMLMediaElement.prototype.pause = () => {};
      window.HTMLMediaElement.prototype.load = () => {};
      window.Element.prototype.scrollIntoView = () => {};
      window.scrollTo = () => {};
      // plain timers stand in for animation frames, so nothing is left running when the page is closed
      window.requestAnimationFrame = cb => window.setTimeout(() => cb(Date.now()), 16);
      window.cancelAnimationFrame = id => window.clearTimeout(id);
      if (lang === 'th') { window.BOKKO_LANG = 'th'; window.eval(scripts.thContent); }
      window.eval(scripts.i18n);
    },
  });
  const { window } = dom;
  for (let i = 0; i < 300 && !window.__bokkoBooted; i++) await new Promise(r => setTimeout(r, 50));
  if (!window.__bokkoBooted) throw new Error(`${page.src} (${lang}) never finished drawing. ${errors.join(' | ')}`);
  await new Promise(r => setTimeout(r, 100));
  const out = {};
  for (const id of page.slots) {
    const el = window.document.getElementById(id);
    // drop any slot markers the page did not overwrite, or they would pile up on every run
    let inner = el ? el.innerHTML.replace(/<!--\/?pr:[A-Za-z]+-->/g, '').trim() : '';
    // marquee tracks hold their cards twice (for the endless loop) — keep one copy
    if (id === 'caseTrack' && inner.length % 2 === 0 && inner.slice(0, inner.length / 2) === inner.slice(inner.length / 2)) inner = inner.slice(0, inner.length / 2);
    out[id] = inner;
  }
  const banner = window.document.getElementById('banner');
  if (banner) out.__banner = { cls: banner.className, style: banner.getAttribute('style') || '' };
  window.close();
  return out;
}

function fillSlots(html, page, drawn) {
  for (const id of page.slots) {
    // greedy on purpose: also collapses markers nested by earlier runs
    const re = new RegExp(`<!--pr:${id}-->[\\s\\S]*<!--/pr:${id}-->`);
    if (!re.test(html)) throw new Error(`${page.src} is missing the <!--pr:${id}--> markers`);
    html = html.replace(re, () => `<!--pr:${id}-->${drawn[id]}<!--/pr:${id}-->`);
  }
  if (drawn.__banner) {
    html = html.replace(/<div class="banner[^"]*" id="banner"[^>]*>/, () =>
      `<div class="${drawn.__banner.cls || 'banner'}" id="banner"${drawn.__banner.style ? ` style="${drawn.__banner.style.replace(/"/g, '&quot;')}"` : ''}>`);
  }
  return html.replace(/<body[^>]*>/, `<body data-prerendered="${new Date().toISOString().slice(0, 10)}">`);
}

/* ---------- turn the baked page into its Thai edition ---------- */
const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, '—').replace(/&rarr;/g, '→');
const encode = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function toThai(html, page, dict, paths) {
  const tr = s => { const v = dict[s] !== undefined ? dict[s] : dict[s.trim()]; return v || null; };
  // Walk the HTML: translate plain text between tags and a few attributes; leave scripts and styles alone.
  const parts = html.split(/(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->|<[^>]+>)/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (part[0] !== '<') {                       // text
      const text = decode(part), th = text.trim() && tr(text.trim());
      if (th) parts[i] = part.match(/^\s*/)[0] + encode(th) + part.match(/\s*$/)[0];
    } else if (/^<(input|textarea|select|button|img|meta|nav|a)\b/i.test(part)) {   // attributes
      parts[i] = part.replace(/\b(placeholder|aria-label|alt|content)="([^"]*)"/g, (m, attr, val) => {
        const th = tr(decode(val));
        return th ? `${attr}="${encode(th).replace(/"/g, '&quot;')}"` : m;
      });
    }
  }
  html = parts.join('');
  // the FAQ structured data sits in a script, which the walk above leaves alone: rebuild it from the translated questions
  html = html.replace(/(<script type="application\/ld\+json" id="homeFaqLd">)[\s\S]*?(<\/script>)/, (m, a, b) => {
    const qa = [...html.matchAll(/<details class="faq">\s*<summary><h3>([\s\S]*?)<\/h3><\/summary>\s*<p>([\s\S]*?)<\/p>/g)]
      .map(x => ({ '@type': 'Question', name: decode(x[1].trim()), acceptedAnswer: { '@type': 'Answer', text: decode(x[2].replace(/<[^>]+>/g, '').trim()) } }));
    if (!qa.length) return m;
    return a + '\n' + JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', '@id': SITE + page.thUrl + '#faq', inLanguage: 'th', mainEntity: qa }, null, 1) + '\n' + b;
  });
  html = html.replace(/<html lang="en">/, '<html lang="th">');
  html = html.replace(/(<link rel="canonical" href=")[^"]*(">)/, `$1${SITE}${page.thUrl}$2`);
  html = html.replace(/(<meta property="og:url" content=")[^"]*(">)/, `$1${SITE}${page.thUrl}$2`);
  html = html.replace(/(<meta property="og:locale" content=")en_US(">)/, '$1th_TH$2');
  html = html.replace('<!--i18n-boot-->', `<script>window.BOKKO_LANG='th'</script>\n<script src="/assets/th-content.js"></script>`);
  // internal links point at the Thai edition of each page
  html = html.replace(/href=(["'])([^"']+)\1/g, (m, q, href) => paths[href] ? `href=${q}${paths[href]}${q}` : m);
  // …except the language switch, which goes back to English
  html = html.replace(/<a class="lang" data-lang-switch [^>]*>[^<]*<\/a>/,
    `<a class="lang" data-lang-switch href="${page.enUrl}" hreflang="en" lang="en" aria-label="Read in English">EN</a>`);
  return html;
}


/* ---------- case-study pages, built from the saved client-work entries ---------- */
const SERVICE_PAGES = {
  'restaurant-marketing-agency': 'Restaurant Marketing', 'hotel-marketing-agency': 'Hotel Marketing',
  'social-media-marketing-agency-bangkok': 'Social Media Marketing', 'digital-marketing-agency-bangkok': 'Digital Marketing',
  'meta-ads-agency-bangkok': 'Meta Ads', 'google-ads-agency-bangkok': 'Google Ads',
  'influencer-marketing-agency': 'Influencer & KOL Marketing', 'content-production-agency': 'Content Production',
};
const RELATED_BY_CATEGORY = {
  restaurant: ['restaurant-marketing-agency', 'social-media-marketing-agency-bangkok', 'content-production-agency'],
  hotel: ['hotel-marketing-agency', 'meta-ads-agency-bangkok', 'content-production-agency'],
  travel: ['meta-ads-agency-bangkok', 'digital-marketing-agency-bangkok', 'google-ads-agency-bangkok'],
  lifestyle: ['social-media-marketing-agency-bangkok', 'influencer-marketing-agency', 'meta-ads-agency-bangkok'],
};
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildCaseStudies(data, dict, paths) {
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = src.match(/const CASE_STUDY_PAGES = (\{[\s\S]*?\});/);
  if (!m) { console.warn('! No CASE_STUDY_PAGES list in index.html, so no case-study pages were built.'); return 0; }
  const pagesById = JSON.parse(m[1]);
  const entries = Object.entries(pagesById)
    .map(([id, slug]) => ({ slug, p: data.projects.find(x => x.id === id) }))
    .filter(e => { if (!e.p) console.warn(`! Case study "${e.slug}": no client-work entry with that id was found. Skipped.`); return !!e.p; });

  for (const lang of ['en', 'th']) {
    const th = lang === 'th';
    const tr = s => { if (!th || typeof s !== 'string') return s; const v = dict[s] !== undefined ? dict[s] : dict[s.trim()]; return v || s; };
    const L = href => (th && paths[href]) || href;
    const base = th ? '/th/case-studies/' : '/case-studies/';
    // The service pages already carry the header, footer, enquiry form and tracking: reuse one as the shell.
    const shell = fs.readFileSync(path.join(ROOT, th ? 'th/restaurant-marketing-agency/index.html' : 'restaurant-marketing-agency/index.html'), 'utf8');
    const lower = s => (!th && /^[A-Z][a-z]/.test(s)) ? s[0].toLowerCase() + s.slice(1) : s;

    const page = ({ rel, title, desc, image, ld, main }) => {
      const url = SITE + base + rel, enUrl = SITE + '/case-studies/' + rel, thUrl = SITE + '/th/case-studies/' + rel;
      let h = shell;
      h = h.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(title)}</title>`);
      h = h.replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${esc(desc)}">`);
      h = h.replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`);
      h = h.replace(/(<link rel="alternate" hreflang="[^"]*" href="[^"]*">\n)+/, `<link rel="alternate" hreflang="en" href="${enUrl}">\n<link rel="alternate" hreflang="th" href="${thUrl}">\n<link rel="alternate" hreflang="x-default" href="${enUrl}">\n`);
      h = h.replace(/(<meta property="og:title" content=")[^"]*/, (x, a) => a + esc(title)).replace(/(<meta name="twitter:title" content=")[^"]*/, (x, a) => a + esc(title));
      h = h.replace(/(<meta property="og:description" content=")[^"]*/, (x, a) => a + esc(desc)).replace(/(<meta name="twitter:description" content=")[^"]*/, (x, a) => a + esc(desc));
      h = h.replace(/(<meta property="og:url" content=")[^"]*/, `$1${url}`).replace(/(<meta property="og:type" content=")[^"]*/, '$1article');
      if (image) h = h.replace(/(<meta property="og:image" content=")[^"]*/, (x, a) => a + esc(image)).replace(/(<meta name="twitter:image" content=")[^"]*/, (x, a) => a + esc(image));
      h = h.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () => `<script type="application/ld+json">\n${JSON.stringify(ld, null, 1)}\n</script>`);
      h = h.replace(/<main id="main" class="container">[\s\S]*?<\/main>/, () => `<main id="main" class="container">\n${main}\n</main>`);
      h = h.replace(/(<input type="hidden" name="page" value=")[^"]*/, `$1${base}${rel}`);
      h = h.replace(/<a class="lang" href="[^"]*"/, `<a class="lang" href="${th ? '/case-studies/' : '/th/case-studies/'}${rel}"`);
      const dir = path.join(ROOT, (th ? 'th/' : '') + 'case-studies', rel);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), h);
    };
    const org = { '@type': 'ProfessionalService', '@id': SITE + '/#organization', name: 'BOKKO', url: SITE + '/' };
    const crumbs = (items) => ({ '@type': 'BreadcrumbList', itemListElement: items.map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })) });
    const home = th ? '/th/' : '/';

    for (const { slug, p } of entries) {
      const title = p.title, result = tr(p.result || ''), intro = tr(p.intro || ''), acc = tr(p.acc || ''), tag = tr(p.tag || '');
      const media = p.media || [];
      const photos = media.filter(x => x.type === 'image' && x.url).slice(0, 6);
      const videos = media.filter(x => x.type === 'video' && x.url && x.poster).slice(0, 3);
      const metrics = (p.metrics || []).filter(x => x && x.label && x.value);
      const chips = [...(p.meta || '').split('·').map(x => x.trim()).filter(Boolean), ...(p.platforms || [])].map(tr);
      const related = RELATED_BY_CATEGORY[p.category] || RELATED_BY_CATEGORY.restaurant;
      const pool = entries.filter(e => e.slug !== slug);
      const others = [...pool.filter(e => e.p.category === p.category), ...pool.filter(e => e.p.category !== p.category)].slice(0, 3);
      // questions and answers built only from what is saved for this client
      const services = (p.meta || '').split('·').map(x => x.trim()).filter(Boolean).map(tr);
      const channels = (p.platforms || []).map(tr);
      const hasAds = (p.platforms || []).some(x => /\bAds\b/i.test(x));
      const metricLine = metrics.map(x => `${tr(x.label)}: ${tr(x.value)}`).join('; ');
      const Q = s => tr(s).replace('{client}', title);
      const stop = s => (s + '.').replace(/\.\.$/, '.');
      const faqs = [
        acc && [Q('What did BOKKO do for {client}?'), acc],
        (result || metricLine) && [Q('What was the result for {client}?'), stop([result, metricLine].filter(Boolean).join('. '))],
        (services.length || channels.length) && [Q('Which services and channels did BOKKO use for {client}?'),
          stop([services.length ? tr('Services:') + ' ' + services.join(', ') : '', channels.length ? tr('Channels:') + ' ' + channels.join(', ') : ''].filter(Boolean).join('. '))],
        hasAds && [Q('Who managed the advertising for {client}?'), tr('BOKKO’s founder, Jack Brown, is personally involved in the strategy, management and optimisation of BOKKO’s advertising campaigns, supported by an in-house team.')],
      ].filter(Boolean);
      const h1 = result ? `${esc(title)}: <span class="pink">${esc(lower(result))}</span>` : esc(title);
      const main = `  <nav class="crumbs" aria-label="Breadcrumb"><a href="${home}">${tr('Home')}</a><span aria-hidden="true">/</span><a href="${base}">${tr('Case studies')}</a><span aria-hidden="true">/</span><span aria-current="page">${esc(title)}</span></nav>

  <section class="hero">
    <div class="eyebrow"><span class="dot"></span> ${tr('Case study')}${tag ? ' · ' + esc(tag) : ''}</div>
    <h1>${h1}</h1>
    ${intro ? `<p class="lead">${esc(intro)}</p>` : ''}
    <div class="hero-actions">
      <a class="btn pinkbtn" href="#contact">${tr('Talk to us about your brand →')}</a>
      <a class="btn" href="${base}">${tr('All case studies')}</a>
    </div>
  </section>
${metrics.length ? `
  <section class="section" id="results">
    <div class="head"><div><span class="eyebrow"><span class="dot"></span>${tr('Results')}</span><h2>${tr('Results at a glance')}</h2></div></div>
    <div class="cs-facts">
${metrics.map(x => `      <div class="cs-fact"><small>${esc(tr(x.label))}</small><strong>${esc(tr(x.value))}</strong></div>`).join('\n')}
    </div>
    <p class="note">${tr('Figures are from BOKKO campaign reporting for this client.')}</p>
  </section>` : ''}

  <section class="section" id="approach">
    <div class="services">
${intro ? `      <article class="service"><h2 class="h3">${tr('The brief')}</h2><p>${esc(intro)}</p></article>` : ''}
${acc ? `      <article class="service"><h2 class="h3">${tr('What BOKKO did')}</h2><p>${esc(acc)}</p></article>` : ''}
    </div>
${chips.length ? `    <h2 class="sr">${tr('Services and channels')}</h2>\n    <div class="chips">${chips.map(c => `<span>${esc(c)}</span>`).join('')}</div>` : ''}
${hasAds ? `    <p class="note">${tr('BOKKO’s founder, Jack Brown, is personally involved in the strategy and optimisation of BOKKO’s advertising campaigns.')} <a class="textlink" href="${L('/about/')}">${tr('About the founder →')}</a></p>` : ''}
  </section>
${photos.length || videos.length ? `
  <section class="section" id="gallery">
    <div class="head"><div><h2>${tr('From the campaign')}</h2></div></div>
    <div class="cs-gallery">
${photos.map((x, i) => `      <img src="/.netlify/images?url=${encodeURIComponent(x.url)}&amp;w=800&amp;q=75" data-orig="${esc(x.url)}" onerror="this.onerror=null;this.src=this.dataset.orig" alt="${esc(title)}, ${tr('campaign photo')} ${i + 1}" loading="lazy" decoding="async" width="800" height="1000">`).join('\n')}
${videos.map((x, i) => `      <video src="${esc(x.url)}" poster="${esc(x.poster)}" controls preload="none" playsinline aria-label="${esc(title)}, ${tr('campaign video')} ${i + 1}"></video>`).join('\n')}
    </div>
  </section>` : ''}

${faqs.length ? `
  <section class="section" id="faq">
    <div class="head"><div><span class="eyebrow"><span class="dot"></span>FAQ</span><h2>${esc(Q('Questions about the {client} project'))}</h2></div></div>
    <div class="faqs">
${faqs.map(([q, a]) => `      <details class="faq">\n        <summary><h3>${esc(q)}</h3></summary>\n        <p>${esc(a)}</p>\n      </details>`).join('\n')}
    </div>
  </section>` : ''}

  <section class="section" id="related">
    <div class="head"><div><h2>${tr('Related services')}</h2></div></div>
    <div class="related">
${related.map(s => `      <a class="rel" href="${L('/' + s + '/')}"><strong>${esc(tr(SERVICE_PAGES[s]))}</strong></a>`).join('\n')}
    </div>
  </section>

  <section class="section" id="more">
    <div class="head"><div><h2>${tr('More case studies')}</h2></div></div>
    <div class="cs-list">
${others.map(e => `      <a class="cs-card" href="${base}${e.slug}/"><span class="tag">${esc(tr(e.p.tag || ''))}</span><h3>${esc(e.p.title)}</h3><p>${esc(tr(e.p.result || ''))}</p><span class="textlink">${tr('Read the case study →')}</span></a>`).join('\n')}
    </div>
  </section>`;
      const url = SITE + base + slug + '/';
      page({
        rel: slug + '/', title: th ? `${tr('Case study')} ${title} | BOKKO` : `${title} Case Study | BOKKO`,
        desc: [result, intro].filter(Boolean).join('. ').replace(/\.\./g, '.'), image: (photos[0] && photos[0].url) || (videos[0] && videos[0].poster) || '',
        ld: { '@context': 'https://schema.org', '@graph': [
          { '@type': 'Article', '@id': url + '#article', headline: `${title}: ${lower(result)}`.slice(0, 110), description: intro || result, inLanguage: lang,
            mainEntityOfPage: url, author: org, publisher: org, about: { '@type': 'Organization', name: title },
            ...(photos[0] ? { image: photos.slice(0, 3).map(x => x.url) } : {}) },
          crumbs([['BOKKO', SITE + home], [tr('Case studies'), SITE + base], [title, url]]),
          ...(faqs.length ? [{ '@type': 'FAQPage', '@id': url + '#faq', inLanguage: lang, mainEntity: faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }] : []),
        ] },
        main,
      });
    }

    // the index page that lists them
    const listUrl = SITE + base;
    page({
      rel: '', title: `${tr('Client case studies')} | BOKKO`,
      desc: tr('Client case studies: BOKKO campaigns for restaurants, hotels, travel and lifestyle brands in Thailand, with the brief, the work and the results.'),
      image: '',
      ld: { '@context': 'https://schema.org', '@graph': [
        { '@type': 'CollectionPage', '@id': listUrl + '#webpage', url: listUrl, name: tr('Client case studies'), inLanguage: lang, publisher: org },
        crumbs([['BOKKO', SITE + home], [tr('Case studies'), listUrl]]),
      ] },
      main: `  <nav class="crumbs" aria-label="Breadcrumb"><a href="${home}">${tr('Home')}</a><span aria-hidden="true">/</span><span aria-current="page">${tr('Case studies')}</span></nav>

  <section class="hero">
    <div class="eyebrow"><span class="dot"></span> ${tr('Case studies')}</div>
    <h1>${tr('Client case studies')}</h1>
    <p class="lead">${tr('Results from BOKKO campaigns for restaurants, hotels, travel and lifestyle brands in Thailand: what each client needed, what we did and what changed.')}</p>
  </section>

  <section class="section" id="list">
    <div class="cs-list">
${entries.map(e => `      <a class="cs-card" href="${base}${e.slug}/"><span class="tag">${esc(tr(e.p.tag || ''))}</span><h2 class="h3">${esc(e.p.title)}</h2><p>${esc(tr(e.p.result || ''))}</p><span class="textlink">${tr('Read the case study →')}</span></a>`).join('\n')}
    </div>
  </section>`,
    });
  }
  return entries.length;
}

(async () => {
  const scripts = {
    i18n: fs.readFileSync(path.join(ROOT, 'assets/i18n.js'), 'utf8'),
    thContent: fs.readFileSync(path.join(ROOT, 'assets/th-content.js'), 'utf8'),
  };
  let data;
  try { data = await loadEverything(); }
  catch (err) { console.error(`Could not read the saved content (${err.message}). Nothing was changed. Check your internet connection and try again.`); process.exit(1); }

  // Thai dictionary = drafts shipped with the site + anything staff saved in admin
  const sandbox = {}; new Function('window', scripts.thContent)(sandbox);
  const dict = Object.assign({}, sandbox.BOKKO_TH.dict);
  for (const p of (data.content.th_dict && data.content.th_dict.pairs) || []) if (p && typeof p.en === 'string') dict[p.en] = p.th || '';
  const paths = sandbox.BOKKO_TH.paths;

  for (const page of PAGES) {
    const source = fs.readFileSync(path.join(ROOT, page.src), 'utf8');
    const en = fillSlots(source, page, await draw(source, page, 'en', data, scripts));
    fs.writeFileSync(path.join(ROOT, page.src), en);
    const th = toThai(fillSlots(source, page, await draw(source, page, 'th', data, scripts)), page, dict, paths);
    fs.mkdirSync(path.dirname(path.join(ROOT, page.th)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, page.th), th);
    const h1 = h => ((h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '(none)').replace(/<[^>]+>/g, '').trim();
    console.log(`${page.src}  →  "${h1(en)}"\n${page.th}  →  "${h1(th)}"`);
  }
  const built = buildCaseStudies(data, dict, paths);
  console.log(`case-studies/  →  ${built} case studies + index, in English and Thai`);
  console.log(`\nDone: ${data.projects.length} client-work entries, ${Object.keys(dict).length} Thai phrases. Deploy when ready.`);
})().catch(err => { console.error('prerender failed:', err.message); process.exit(1); });
