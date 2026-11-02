(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerConsumption = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  var DAY_MS = 86400000;

  function nonnegative(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }

  // Accept only real UTC timestamps, rejecting Date.parse's calendar rollover.
  function timestamp(value) {
    if (typeof value !== 'string') return null;
    var match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
    if (!match) return null;
    // Rust timestamps can carry microseconds; normalize both ends to JS milliseconds.
    var normalized = value.slice(0, 19) + '.' + ((match[7] || '') + '000').slice(0, 3) + 'Z';
    var milliseconds = Date.parse(normalized);
    if (!Number.isFinite(milliseconds)) return null;
    var date = new Date(milliseconds);
    var parts = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
      date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()];
    if (parts.some(function (part, index) { return part !== Number(match[index + 1]); })) return null;
    return milliseconds;
  }

  function point(period, index) {
    var source = period && typeof period === 'object' ? period : {};
    var start = timestamp(source.start_at);
    var end = timestamp(source.end_at);
    var days = start !== null && end !== null ? (end - start) / DAY_MS : null;
    var reason = source.exclusion || null;
    if (!reason && (days === null || days <= 0)) reason = 'invalid_time';
    if (!reason && days < 1) reason = 'short_period';
    if (!reason && !nonnegative(source.consumption)) reason = 'invalid_consumption';
    // Optional supporting values may be absent; present invalid values cannot be trusted.
    ['opening_qty', 'closing_qty', 'waste', 'gross_depletion'].forEach(function (key) {
      if (!reason && source[key] != null && !nonnegative(source[key])) reason = 'invalid_' + key;
    });
    // Net receipts include signed corrections to earlier receipts.
    if (!reason && source.received != null &&
        (typeof source.received !== 'number' || !Number.isFinite(source.received))) reason = 'invalid_received';
    var rate = reason ? null : source.consumption / days;
    if (!reason && !Number.isFinite(rate)) reason = 'invalid_rate';
    return Object.assign({}, source, {
      sourceIndex: index, startMs: start, endMs: end, elapsedDays: days,
      valid: !reason, reason: reason, dailyRate: reason ? null : rate,
      connectPrevious: false, gapBefore: false
    });
  }

  function analyze(item) {
    var periods = item && Array.isArray(item.periods) ? item.periods : [];
    var points = periods.map(point).sort(function (a, b) {
      // Unknown dates stay visible at the end, so no line crosses them.
      if (a.endMs === null && b.endMs !== null) return 1;
      if (b.endMs === null && a.endMs !== null) return -1;
      return (a.endMs - b.endMs) || (a.startMs - b.startMs) || a.sourceIndex - b.sourceIndex;
    });
    points.forEach(function (current, index) {
      if (!index) return;
      var previous = points[index - 1];
      current.gapBefore = previous.endMs === null || current.startMs === null || previous.endMs !== current.startMs;
      current.connectPrevious = current.valid && previous.valid && !current.gapBefore;
    });
    var valid = points.filter(function (entry) { return entry.valid; });
    var latest = valid.length ? valid[valid.length - 1] : null;
    var previous = valid.length > 1 ? valid[valid.length - 2] : null;
    var change = { kind: 'no_comparison', percent: null, delta: null };
    if (previous) {
      var delta = latest.dailyRate - previous.dailyRate;
      change.delta = delta;
      if (previous.dailyRate === 0) {
        change.kind = latest.dailyRate === 0 ? 'flat' : 'from_zero';
        change.percent = latest.dailyRate === 0 ? 0 : null;
      } else {
        change.kind = delta === 0 ? 'flat' : delta > 0 ? 'up' : 'down';
        var percent = delta / previous.dailyRate * 100;
        change.percent = Number.isFinite(percent) ? percent : null;
      }
    }
    var sampleDays = valid.reduce(function (sum, entry) { return sum + entry.elapsedDays; }, 0);
    var consumption = valid.reduce(function (sum, entry) { return sum + entry.consumption; }, 0);
    var wasteKnown = valid.length > 0 && valid.every(function (entry) { return nonnegative(entry.waste); });
    return {
      latest: latest, previous: previous, change: change,
      validCount: valid.length, totalCount: points.length, trendReady: valid.length >= 3,
      sampleDays: sampleDays,
      totalConsumption: valid.length ? consumption : null,
      totalWaste: wasteKnown ? valid.reduce(function (sum, entry) { return sum + entry.waste; }, 0) : null,
      averageDailyRate: valid.length ? consumption / sampleDays : null,
      points: points
    };
  }

  return { analyze: analyze };
});
