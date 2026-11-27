/* BOKKO — Meta Pixel loader, shared by every public page.
   The Pixel ID is managed in admin.html → Branding → Tracking (saved to
   Firestore at content/tracking). To avoid waiting on the network, each page
   fires the last-known ID straight away (falling back to DEFAULT_ID for a
   first-time visitor), then checks Firestore and remembers the answer for
   the next page view. Saving an empty ID in admin switches the pixel off. */
(function () {
  var DEFAULT_ID = '1264364178210493';
  var KEY = 'bokko_meta_pixel_id';
  var DOC = 'https://firestore.googleapis.com/v1/projects/bokko-6dc83/databases/(default)/documents/content/tracking';
  var fired = {};

  function valid(id) { return /^\d{6,20}$/.test(id); }

  function fire(id) {
    if (!valid(id) || fired[id]) return;
    fired[id] = true;
    /* Standard Meta Pixel base code */
    !function(f,b,e,v,n,t,s)
    {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};
    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
    n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s)}(window, document,'script',
    'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', id);
    fbq('trackSingle', id, 'PageView');
  }

  var id = DEFAULT_ID;
  try {
    var cached = localStorage.getItem(KEY);
    if (cached !== null) id = cached;
  } catch (e) {}
  fire(id);

  if (!window.fetch) return;
  fetch(DOC).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d || !d.fields || !d.fields.metaPixelId) return; /* nothing saved in admin yet */
    var saved = String(d.fields.metaPixelId.stringValue || '').trim();
    try { localStorage.setItem(KEY, saved); } catch (e) {}
    fire(saved);
  }).catch(function () {});
})();
