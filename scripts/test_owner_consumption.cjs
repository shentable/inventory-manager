'use strict';
const assert = require('node:assert/strict');
const { analyze } = require('../web/js/owner-consumption.js');

function period(start, end, consumption, extra = {}) {
  return { start_at: start, end_at: end, consumption, waste: 0, exclusion: null, ...extra };
}
const d = (day) => `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`;
const p = (start, end, amount, extra) => period(d(start), d(end), amount, extra);

// Compare daily rates, never totals across different durations; do not trust rounded API values.
let result = analyze({ periods: [p(3, 7, 8, { days: 4, daily_rate: 2 }), p(1, 3, 6)] });
assert.equal(result.change.kind, 'down');
assert.equal(result.latest.dailyRate, 2);
assert.equal(result.previous.dailyRate, 3);
assert.ok(Math.abs(result.change.percent + 100 / 3) < 1e-10);
assert.equal(result.sampleDays, 6);
assert.equal(result.averageDailyRate, 14 / 6);
assert.equal(result.trendReady, false);

result = analyze({ periods: [p(1, 2, 1.01, { daily_rate: 1 }), p(2, 3, 1.04, { daily_rate: 1 })] });
assert.equal(result.change.kind, 'up');
assert.ok(result.change.percent > 2.9);
result = analyze({ periods: [period(d(1), '2026-10-02T12:00:00Z', 3, { days: 1.5 })] });
assert.equal(result.sampleDays, 1.5);
assert.equal(result.latest.dailyRate, 2);
result = analyze({ periods: [period(d(1), '2026-10-02T01:00:00Z', 25, { days: 1, daily_rate: 24 })] });
assert.equal(result.sampleDays, 25 / 24);
assert.equal(result.latest.dailyRate, 24);
for (const fraction of ['1', '12', '123', '123456', '999999', '123456789']) {
  result = analyze({ periods: [period(`2026-10-01T00:00:00.${fraction}Z`, `2026-10-02T00:00:00.${fraction}Z`, 2)] });
  assert.equal(result.validCount, 1);
  assert.equal(result.sampleDays, 1);
  assert.equal(result.latest.dailyRate, 2);
}
result = analyze({ periods: [period('2026-10-01T00:00:00.123456Z', '2026-10-02T00:00:00.999999Z', 2)] });
assert.equal(result.latest.endMs - result.latest.startMs, 86400000 + 876);
result = analyze({ periods: [p(1, 2, 40, { opening_qty: 100, received: -10, closing_qty: 50, waste: 0 })] });
assert.equal(result.validCount, 1);
assert.equal(result.latest.dailyRate, 40);
for (const received of [Infinity, NaN, '-10']) {
  assert.equal(analyze({ periods: [p(1, 2, 40, { received })] }).validCount, 0);
}

assert.equal(analyze({ periods: [p(1, 2, 0), p(2, 3, 1)] }).change.kind, 'from_zero');
assert.equal(analyze({ periods: [p(1, 2, 0), p(2, 3, 1)] }).change.percent, null);
assert.deepEqual(analyze({ periods: [p(1, 2, 0), p(2, 3, 0)] }).change, { kind: 'flat', percent: 0, delta: 0 });
assert.equal(analyze({ periods: [p(1, 2, 1), p(2, 3, 0)] }).change.percent, -100);
assert.equal(analyze({ periods: [p(1, 2, 0)] }).change.kind, 'no_comparison');
for (const input of [undefined, {}, { periods: [] }, { periods: null }]) {
  result = analyze(input);
  assert.equal(result.latest, null);
  assert.equal(result.totalConsumption, null);
  assert.equal(result.averageDailyRate, null);
  assert.equal(result.validCount, 0);
}

const input = { forecast_issue: 'expired_stock', periods: [p(5, 6, 3), p(3, 4, 2), p(2, 3, 0, { exclusion: 'pending_waste' }), p(1, 2, 1)] };
const original = JSON.stringify(input);
result = analyze(input);
assert.equal(JSON.stringify(input), original);
assert.equal(result.validCount, 3);
assert.equal(result.totalCount, 4);
assert.equal(result.trendReady, true);
assert.deepEqual(result.points.map((entry) => entry.valid), [true, false, true, true]);
assert.deepEqual(result.points.map((entry) => entry.connectPrevious), [false, false, false, false]);
assert.equal(result.points[3].gapBefore, true);
for (const forecast_issue of ['stale_count', 'pending_waste', 'zero_rate']) {
  assert.equal(analyze({ ...input, forecast_issue }).validCount, 3);
}
result = analyze({ periods: [p(3, 4, 3), p(1, 2, 1), p(2, 3, 2)] });
assert.deepEqual(result.points.map((entry) => entry.connectPrevious), [false, true, true]);
assert.equal(result.latest.consumption, 3);

for (const consumption of [null, undefined, -1, Infinity, NaN, '0']) {
  assert.equal(analyze({ periods: [p(1, 2, consumption)] }).validCount, 0);
}
for (const start_at of ['2026-02-30T00:00:00Z', '2026-10-01', 'nonsense', null, '2026-10-01T24:00:00Z']) {
  assert.equal(analyze({ periods: [period(start_at, d(3), 1)] }).validCount, 0);
}
for (const entry of [p(2, 1, 1), p(1, 1, 1), p(1, 2, 1, { waste: -1 }), null]) {
  assert.equal(analyze({ periods: [entry] }).validCount, 0);
}
assert.equal(analyze({ periods: [p(1, 2, 0)] }).totalConsumption, 0);
assert.equal(analyze({ periods: [p(1, 2, 0, { waste: null })] }).totalWaste, null);
console.log('owner consumption model: all assertions passed');
