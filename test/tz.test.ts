import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoneOffsetMinutes, arrivalShiftMinutes } from '../src/core/tz.ts';
import { AIRPORT_ZONES } from '../src/core/zones.ts';
import { todayEpochDay } from '../src/core/tz.ts';
import { marketDataset } from '../src/core/markets.ts';

/** Departure as minutes since the epoch on the origin's wall clock. */
const depart = (y: number, m: number, d: number, hh: number, mm = 0) =>
  Date.UTC(y, m - 1, d, hh, mm) / 60000;

/** The table maps airport to zone; tz.ts deals only in zones. */
const Z = AIRPORT_ZONES;

const JAN = Date.UTC(2026, 0, 15, 12);
const JUL = Date.UTC(2026, 6, 15, 12);

test('reads standard and summer offsets', () => {
  assert.equal(zoneOffsetMinutes('America/Los_Angeles', JAN), -480);
  assert.equal(zoneOffsetMinutes('America/Los_Angeles', JUL), -420);
  assert.equal(zoneOffsetMinutes('America/New_York', JAN), -300);
  assert.equal(zoneOffsetMinutes('UTC', JAN), 0);
});

test('zones that do not keep DST hold still', () => {
  // These are the two that make a stored per-airport offset wrong.
  assert.equal(zoneOffsetMinutes('America/Phoenix', JAN), -420);
  assert.equal(zoneOffsetMinutes('America/Phoenix', JUL), -420);
  assert.equal(zoneOffsetMinutes('Pacific/Honolulu', JAN), -600);
  assert.equal(zoneOffsetMinutes('Pacific/Honolulu', JUL), -600);
});

test('shifts a transcontinental arrival by three hours', () => {
  // 08:00 out of LAX, 5h20 in the air, lands 16:20 in New York — not 13:20.
  const shift = arrivalShiftMinutes(Z.LAX, Z.JFK, depart(2026, 6, 15, 8), 320);
  assert.equal(shift, 180);
});

test('the shift is the same in winter when both ends keep DST', () => {
  const summer = arrivalShiftMinutes(Z.LAX, Z.JFK, depart(2026, 6, 15, 8), 320);
  const winter = arrivalShiftMinutes(Z.LAX, Z.JFK, depart(2026, 1, 15, 8), 320);
  assert.equal(summer, winter, 'LAX-JFK should be 3h all year');
});

test('the shift moves across the year when one end does not keep DST', () => {
  // The case a per-airport constant gets wrong for half the year.
  const winter = arrivalShiftMinutes(Z.LAX, Z.PHX, depart(2026, 1, 15, 9), 85);
  const summer = arrivalShiftMinutes(Z.LAX, Z.PHX, depart(2026, 6, 15, 9), 85);
  assert.equal(winter, 60);
  assert.equal(summer, 0);
});

test('westbound shifts are negative', () => {
  const shift = arrivalShiftMinutes(Z.JFK, Z.LAX, depart(2026, 6, 15, 8), 360);
  assert.equal(shift, -180);
  assert.equal(arrivalShiftMinutes(Z.LAX, Z.HNL, depart(2026, 6, 15, 9), 340), -180);
});

test('a late departure lands on the next date once corrected', () => {
  // The bug at its worst: uncorrected this reads 23:21 on the day it left,
  // so the list showed both the wrong clock and the wrong date.
  const dep = depart(2026, 6, 15, 17, 37);
  const duration = 344;
  const naiveArrival = dep + duration;
  const corrected = naiveArrival + arrivalShiftMinutes(Z.LAX, Z.JFK, dep, duration);
  const day = (min: number) => Math.floor(min / 1440);
  const clock = (min: number) => ((min % 1440) + 1440) % 1440;

  assert.equal(day(naiveArrival) - day(dep), 0, 'uncorrected it reads as the same day');
  assert.equal(clock(naiveArrival), 23 * 60 + 21, 'uncorrected it reads 23:21');
  assert.equal(day(corrected) - day(dep), 1, 'really it lands the next day');
  assert.equal(clock(corrected), 2 * 60 + 21, '02:21 local');
});

test('a red-eye keeps its next-day marker and gains three hours', () => {
  const dep = depart(2026, 6, 15, 23, 35);
  const duration = 319;
  const corrected = dep + duration + arrivalShiftMinutes(Z.LAX, Z.JFK, dep, duration);
  const day = (min: number) => Math.floor(min / 1440);
  assert.equal(day(corrected) - day(dep), 1);
  assert.equal(((corrected % 1440) + 1440) % 1440, 7 * 60 + 54, '07:54, not 04:54');
});

test('same zone needs no shift', () => {
  assert.equal(arrivalShiftMinutes(Z.LAX, Z.SFO, depart(2026, 6, 15, 9), 85), 0);
  assert.equal(arrivalShiftMinutes(Z.JFK, Z.BOS, depart(2026, 1, 15, 9), 75), 0);
});

test('an airport with no zone is left alone rather than guessed at', () => {
  assert.equal(arrivalShiftMinutes(Z.LAX, undefined, depart(2026, 6, 15, 9), 300), 0);
  assert.equal(arrivalShiftMinutes(undefined, Z.JFK, depart(2026, 6, 15, 9), 300), 0);
});

test('a flight that crosses the autumn DST change is right at both ends', () => {
  // US clocks go back at 02:00 local on 2026-11-01. A flight airborne across
  // it sees a different offset at each end, which is why the offsets are read
  // at two instants rather than one.
  const dep = depart(2026, 11, 1, 0, 30);
  const shift = arrivalShiftMinutes(Z.LAX, Z.JFK, dep, 330);
  // LAX is still on PDT (-7) at 00:30; JFK has already returned to EST (-5).
  assert.equal(shift, 120);
});

test('every airport in the dataset has a zone ICU can resolve', () => {
  // A zone this runtime cannot resolve formats as UTC and silently undoes the
  // correction, so the dataset and the table have to stay in step.
  const dataset = marketDataset();
  const missing: string[] = [];
  for (const airport of dataset.airports) {
    const zone = AIRPORT_ZONES[airport.iata];
    if (!zone) { missing.push(airport.iata); continue; }
    assert.doesNotThrow(
      () => new Intl.DateTimeFormat('en-US', { timeZone: zone }),
      `${airport.iata}: unresolvable zone ${zone}`,
    );
  }
  assert.deepEqual(missing, [], 'run scripts/fetch-zones.ts');
});

test('reusing formatters gives the same answers as fresh ones', () => {
  const shared = new Map<string, Intl.DateTimeFormat>();
  for (const instant of [JAN, JUL, Date.UTC(2026, 10, 1, 9)]) {
    for (const zone of ['America/Los_Angeles', 'America/Phoenix', 'America/New_York']) {
      assert.equal(
        zoneOffsetMinutes(zone, instant, shared),
        zoneOffsetMinutes(zone, instant),
        `${zone} disagreed with a cached formatter`,
      );
    }
  }
});

test('today is today, in whole UTC days', () => {
  const today = todayEpochDay();
  assert.equal(today, Math.floor(Date.now() / 86_400_000));
  // A date, not a timestamp: ~20k today, and it must not be a float.
  assert.equal(today, Math.trunc(today));
  const asDate = new Date(today * 86_400_000);
  assert.equal(asDate.getUTCHours(), 0, 'should land on midnight UTC');
  assert.equal(asDate.getUTCDate(), new Date().getUTCDate());
});
