/* BOKKO — language helper shared by the homepage and advisory page.
   English pages: everything here is a pass-through.
   Thai pages (/th/…): window.BOKKO_LANG is 'th' and /assets/th-content.js has
   loaded the draft dictionary. t() and trDeep() swap English text for its Thai
   entry; text with no entry stays in English. addSaved() layers the staff's
   edits from admin (Firestore content/th_dict) over the drafts. */
(function () {
  var LANG = window.BOKKO_LANG === 'th' ? 'th' : 'en';
  var TH = window.BOKKO_TH || {};
  var dict = Object.assign({}, TH.dict || {});
  var paths = TH.paths || {};

  function t(s) {
    if (LANG !== 'th' || typeof s !== 'string') return s;
    var v = dict[s];
    if (v === undefined) v = dict[s.trim()];
    return v ? v : s;
  }
  function trDeep(x) {
    if (LANG !== 'th') return x;
    if (typeof x === 'string') return t(x);
    if (Array.isArray(x)) return x.map(trDeep);
    if (x && typeof x === 'object') { var o = {}; for (var k in x) o[k] = trDeep(x[k]); return o; }
    return x;
  }
  function L(path) { return (LANG === 'th' && paths[path]) || path; }
  function addSaved(data) {
    ((data && data.pairs) || []).forEach(function (p) {
      if (p && typeof p.en === 'string') dict[p.en] = typeof p.th === 'string' ? p.th : '';
    });
  }
  window.BOKKO_I18N = { LANG: LANG, t: t, trDeep: trDeep, L: L, addSaved: addSaved };
})();
