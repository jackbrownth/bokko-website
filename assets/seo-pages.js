/* BOKKO — service landing pages. Same enquiry-form behaviour as index.html:
   saves the enquiry to admin → Leads (see leads.js), sends the Netlify
   "contact" form email, and shows a thank-you in place. Without JS the form
   still posts normally. */
(function () {
  var y = document.getElementById('footerYear');
  if (y) y.textContent = new Date().getFullYear();

  /* Logo: /logo.png shows straight away; if a different logo has been saved in
     admin → Branding, switch to that so these pages always match the main site. */
  var logo = document.querySelector('#siteMark img');
  if (logo && window.fetch) {
    fetch('https://firestore.googleapis.com/v1/projects/bokko-6dc83/databases/(default)/documents/content/branding')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var url = d && d.fields && d.fields.logoImage && d.fields.logoImage.stringValue;
        if (url) logo.src = url;
      }).catch(function () {});
  }

  var form = document.getElementById('leadForm');
  if (!form) return;
  var th = document.documentElement.lang === 'th';
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = form.querySelector('button[type="submit"]');
    var label = btn.textContent;
    var old = form.querySelector('.form-error');
    if (old) old.remove();
    btn.disabled = true;
    btn.textContent = th ? 'กำลังส่ง…' : 'Sending…';
    // Honeypot: a filled hidden field means a bot. Show success, save nothing.
    var data = new FormData(form);
    var fields = { name: data.get('name'), email: data.get('email'), brand: data.get('brand'), need: data.get('need'), message: data.get('message'), lang: th ? 'th' : 'en' };
    var sending = data.get('bot-field') ? Promise.resolve()
      : window.BOKKO_LEADS ? window.BOKKO_LEADS.send(form, fields)   // saves to admin → Leads and emails the team
      : fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() })
          .then(function (res) { if (!res.ok) throw new Error('Submission failed'); });
    sending.then(function () {
      form.innerHTML = '<div class="form-success" role="status"><div class="form-success-icon">✓</div><h3>' +
        (th ? 'ขอบคุณที่ติดต่อเรา' : 'Thank you for getting in touch!') + '</h3><p>' +
        (th ? 'เราได้รับข้อความของคุณแล้ว และจะติดต่อกลับโดยเร็วที่สุด' : "We've received your message and will get back to you soon.") + '</p></div>';
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = label;
      var err = document.createElement('div');
      err.className = 'form-error';
      err.setAttribute('role', 'alert');
      err.textContent = th ? 'ส่งข้อความไม่สำเร็จ กรุณาลองอีกครั้ง หรืออีเมลหาเราที่ info@bokko.co'
        : 'Something went wrong sending that — please try again, or email us directly at info@bokko.co.';
      form.appendChild(err);
    });
  });
})();
