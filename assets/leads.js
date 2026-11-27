/* BOKKO — enquiry capture, shared by every public page.
   1. Remembers how the visitor arrived (ad campaign tags, click IDs, first page)
      for the length of their visit.
   2. BOKKO_LEADS.submit(fields) saves an enquiry to the Leads tab in admin
      (Firestore collection "leads"). The database rules let anyone add an
      enquiry but only signed-in staff read or change one.
   3. BOKKO_LEADS.converted(id, fields) reports the lead to the Meta Pixel and
      Google Analytics. It is called only after an enquiry has really been
      received, and never passes names, emails or phone numbers. */
(function () {
  var PROJECT = 'bokko-6dc83';
  var KEY = 'bokko_attr';
  var PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];

  function cut(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }

  // ---- how the visitor arrived (first page of the visit wins)
  function readAttribution() {
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) {}
    if (saved && typeof saved === 'object') return saved;
    var a = {}, q;
    try { q = new URLSearchParams(location.search); } catch (e) { q = null; }
    PARAMS.forEach(function (p) { var v = q && q.get(p); if (v) a[p] = cut(v, 200); });
    var ref = document.referrer || '';
    if (ref && ref.indexOf(location.origin) !== 0) a.referrer = cut(ref, 300);
    a.landing = cut(location.pathname, 200);
    try { sessionStorage.setItem(KEY, JSON.stringify(a)); } catch (e) {}
    return a;
  }
  var attribution = readAttribution();

  function newId() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', out = '';
    var buf = new Uint8Array(20);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (var i = 0; i < 20; i++) out += chars[buf[i] % chars.length];
    return out;
  }

  var str = function (v) { return { stringValue: v }; };

  /* fields: name, email, phone, line, brand, businessType, need, service,
     serviceDetail, message, lang, page. Resolves with the new lead's id. */
  function submit(fields) {
    var f = fields || {};
    var id = newId();
    var doc = {
      name: str(cut(f.name, 120)),
      email: str(cut(f.email, 200)),
      phone: str(cut(f.phone, 60)),
      line: str(cut(f.line, 80)),
      brand: str(cut(f.brand, 160)),
      businessType: str(cut(f.businessType, 80)),
      need: str(cut(f.need, 160)),
      service: str(cut(f.service, 80)),
      serviceDetail: str(cut(f.serviceDetail, 120)),
      message: str(cut(f.message, 4000)),
      lang: str(cut(f.lang || document.documentElement.lang || 'en', 5)),
      page: str(cut(f.page || location.pathname, 200)),
      channel: str('website'),
      status: str('new'),
      attribution: { mapValue: { fields: {} } }
    };
    Object.keys(attribution).forEach(function (k) { doc.attribution.mapValue.fields[k] = str(cut(attribution[k], 300)); });
    var base = 'projects/' + PROJECT + '/databases/(default)/documents';
    return fetch('https://firestore.googleapis.com/v1/' + base + ':commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes: [{
        update: { name: base + '/leads/' + id, fields: doc },
        updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }],
        currentDocument: { exists: false }
      }] })
    }).then(function (res) {
      if (!res.ok) throw new Error('Lead not saved (' + res.status + ')');
      return id;
    });
  }

  function converted(id, fields) {
    var f = fields || {};
    try { if (window.fbq) window.fbq('track', 'Lead', {}, { eventID: id }); } catch (e) {}
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({
        event: 'generate_lead', lead_id: id,
        lead_service: cut(f.service || f.need, 80),
        lead_language: cut(f.lang || document.documentElement.lang || 'en', 5),
        lead_page: location.pathname
      });
    } catch (e) {}
  }

  /* Used by every enquiry form: saves the lead to admin and sends the usual
     email notification (Netlify Forms) side by side. The visitor sees success
     if either got through, so one service being down never loses an enquiry. */
  function send(form, fields) {
    var id = null;
    var saved = submit(fields).then(function (newLeadId) { id = newLeadId; return true; }, function () { return false; });
    var emailed = fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData(form)).toString()
    }).then(function (res) { return res.ok; }, function () { return false; });
    return Promise.all([saved, emailed]).then(function (ok) {
      if (!ok[0] && !ok[1]) throw new Error('Submission failed');
      converted(id || newId(), fields);
      return id;
    });
  }

  window.BOKKO_LEADS = { submit: submit, converted: converted, send: send, attribution: attribution };
})();
