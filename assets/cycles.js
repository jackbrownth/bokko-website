/* BOKKO — contract and reporting cycles.
 *
 * One place that answers: for this client, which dates does each monthly cycle
 * cover, when is each report due, and how long is left on the contract?
 * Used by the admin Clients tab; the client dashboard and the monthly report
 * job will use the same rules, so everyone always sees the same dates.
 *
 * The rules
 *   - A cycle normally starts on the same day of the month as the contract
 *     (contract starts on the 15th: cycles run 15th to 14th). A different
 *     start day can be set per client.
 *   - In a short month the cycle starts on the last day of that month
 *     (a 31st contract: 31 Jan, 28 Feb, 31 Mar ...).
 *   - "Extra days" added to a contract extend its final cycle.
 *   - Any cycle's start or end can be changed by hand. The next cycle then
 *     starts the day after, so there is never a gap or an overlap.
 *
 * Dates are plain 'YYYY-MM-DD' text, always meaning the day in Thailand.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BOKKO_CYCLES = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var DAY = 86400000;

  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = toDate(s);
    return fmt(d) === s;                           // rejects 2026-02-31 and the like
  }
  function toDate(s) { var p = String(s).split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12)); }
  function fmt(d) { return d.toISOString().slice(0, 10); }
  function addDays(s, n) { return fmt(new Date(toDate(s).getTime() + n * DAY)); }
  function diffDays(a, b) { return Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY); }   // b minus a
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0, 12)).getUTCDate(); }

  /* The cycle start that falls in the month `monthsOn` months after `anchor`, on day-of-month `day`. */
  function monthStart(anchor, monthsOn, day) {
    var a = toDate(anchor);
    var y = a.getUTCFullYear(), m = a.getUTCMonth() + monthsOn;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return fmt(new Date(Date.UTC(y, m, Math.min(day, daysInMonth(y, m)), 12)));
  }

  /* Today's date in Thailand, whatever the computer's own clock zone is. */
  function today(now) {
    var d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    return new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10);       // Thailand is UTC+7 all year
  }

  /* All cycles of a contract.
     client: { contractStart, contractEnd, cycleDay?, extraDays?, cycleOverrides?: { "3": { start?, end? } } } */
  function build(client) {
    var c = client || {};
    var out = { cycles: [], problems: [], start: c.contractStart || '', end: '', baseEnd: c.contractEnd || '', extraDays: 0 };
    if (!isDate(c.contractStart)) { out.problems.push('Enter the contract start date.'); return out; }
    if (!isDate(c.contractEnd)) { out.problems.push('Enter the contract end date.'); return out; }
    if (c.contractEnd < c.contractStart) { out.problems.push('The contract ends before it starts.'); return out; }
    var extra = Math.max(0, Math.min(366, Math.floor(Number(c.extraDays) || 0)));
    var end = addDays(c.contractEnd, extra);
    out.extraDays = extra; out.end = end;
    var startDay = toDate(c.contractStart).getUTCDate();
    var day = Math.floor(Number(c.cycleDay) || 0);
    if (!(day >= 1 && day <= 31)) day = startDay;

    // 1. the regular schedule
    var starts = [c.contractStart];
    // If the cycle day differs from the contract's start day, the first cycle runs up to the first cycle day.
    var firstRegular = day === startDay ? null : (function () {
      var sameMonth = monthStart(c.contractStart, 0, day);
      return sameMonth > c.contractStart ? sameMonth : monthStart(c.contractStart, 1, day);
    })();
    var anchor = firstRegular || c.contractStart;
    if (firstRegular && firstRegular <= c.contractEnd) starts.push(firstRegular);
    for (var i = 1; i < 240; i++) {
      var s = monthStart(anchor, i, day);
      if (s > c.contractEnd) break;
      starts.push(s);
    }
    var base = starts.map(function (s, n) {
      return { n: n + 1, start: s, end: n + 1 < starts.length ? addDays(starts[n + 1], -1) : end };
    });

    // 2. changes made by hand, keeping the cycles back to back
    var over = c.cycleOverrides || {};
    var prevEnd = null;
    base.forEach(function (cy) {
      var o = over[String(cy.n)] || {};
      var changed = { start: false, end: false };
      var start = cy.start, finish = cy.end;
      if (prevEnd && addDays(prevEnd, 1) !== start) start = addDays(prevEnd, 1);     // follow a moved neighbour
      if (isDate(o.start)) { start = o.start; changed.start = true; }
      if (isDate(o.end)) { finish = o.end; changed.end = true; }
      if (finish < start) out.problems.push('Cycle ' + cy.n + ' ends before it starts.');
      if (prevEnd && start <= prevEnd) out.problems.push('Cycle ' + cy.n + ' overlaps cycle ' + (cy.n - 1) + '.');
      if (prevEnd && diffDays(prevEnd, start) > 1) out.problems.push('There is a gap before cycle ' + cy.n + '.');
      out.cycles.push({
        n: cy.n, start: start, end: finish, days: diffDays(start, finish) + 1, due: addDays(finish, 1),
        regularStart: cy.start, regularEnd: cy.end, changed: changed
      });
      prevEnd = finish;
    });
    if (out.cycles.length) out.end = out.cycles[out.cycles.length - 1].end > end ? out.cycles[out.cycles.length - 1].end : end;
    return out;
  }

  /* Where a contract stands on a given day. */
  function status(client, on) {
    var t = on || today();
    var b = build(client);
    var s = { today: t, phase: 'incomplete', cycles: b.cycles, problems: b.problems, total: b.cycles.length,
      current: null, next: null, lastDone: null, daysToStart: null, daysToEnd: null, daysLeftInCycle: null, end: b.end, extraDays: b.extraDays };
    if (!b.cycles.length) return s;
    var first = b.cycles[0], last = b.cycles[b.cycles.length - 1];
    s.daysToEnd = diffDays(t, b.end);
    if (t < first.start) { s.phase = 'upcoming'; s.daysToStart = diffDays(t, first.start); s.next = first; return s; }
    if (t > b.end) { s.phase = 'ended'; s.lastDone = last; return s; }
    s.phase = 'active';
    b.cycles.forEach(function (cy) {
      if (t >= cy.start && t <= cy.end) s.current = cy;
      if (cy.end < t) s.lastDone = cy;
      if (!s.next && cy.start > t) s.next = cy;
    });
    if (s.current) s.daysLeftInCycle = diffDays(t, s.current.end);
    s.ending = s.daysToEnd <= 30 ? 'soon' : s.daysToEnd <= 60 ? 'near' : '';
    return s;
  }

  return { build: build, status: status, today: today, addDays: addDays, diffDays: diffDays, isDate: isDate };
});
