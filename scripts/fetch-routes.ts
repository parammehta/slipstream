/**
 * Regenerates src/core/routes.ts from OpenFlights.
 *
 *   node scripts/fetch-routes.ts
 *
 * The result is committed, so builds and tests never touch the network. Run
 * this only to refresh the data.
 *
 * The set is curated rather than complete: the busiest airports, the airlines
 * that actually serve them, and only the routes that genuinely exist between
 * them. Random city pairs would be smaller and simpler, but then Southwest
 * would be flying Mumbai to Delhi.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/';

const AIRPORT_LIMIT = 140;
const CARRIER_LIMIT = 32; // the carrier bitmask is a u32, so this is the ceiling

async function get(file: string): Promise<string> {
  const res = await fetch(BASE + file, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return res.text();
}

/** OpenFlights uses quoted CSV; fields can contain commas. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const [airportsRaw, routesRaw] = await Promise.all([get('airports.dat'), get('routes.dat')]);

interface Airport { iata: string; city: string; lat: number; lon: number }
const byIata = new Map<string, Airport>();
for (const line of airportsRaw.split('\n')) {
  const c = splitCsv(line);
  if (c.length < 8) continue;
  const iata = c[4];
  if (!/^[A-Z]{3}$/.test(iata)) continue;
  const lat = Number(c[6]);
  const lon = Number(c[7]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  byIata.set(iata, { iata, city: c[2], lat, lon });
}

interface Leg { airline: string; src: string; dst: string }
const legs: Leg[] = [];
const degree = new Map<string, number>();
const airlineRoutes = new Map<string, number>();
for (const line of routesRaw.split('\n')) {
  const c = line.split(',');
  if (c.length < 5) continue;
  const [airline, , src, , dst, , codeshare, stopCount] = c;
  if (src === dst || !byIata.has(src) || !byIata.has(dst)) continue;
  if (!/^[A-Z0-9]{2}$/.test(airline)) continue;
  // Codeshares would make United "serve" Dubai–Doha, which it does not fly.
  if (codeshare === 'Y') continue;
  // Keep only genuinely direct legs; multi-stop entries are not a route pair.
  if (stopCount !== undefined && stopCount.trim() !== '0') continue;
  legs.push({ airline, src, dst });
  degree.set(src, (degree.get(src) ?? 0) + 1);
  degree.set(dst, (degree.get(dst) ?? 0) + 1);
  airlineRoutes.set(airline, (airlineRoutes.get(airline) ?? 0) + 1);
}

// Carriers first, then the airports they actually serve. Choosing airports
// first leaves ones that look connectable but are not: Mumbai and Delhi are
// both enormous, yet every airline flying between them sits outside a global
// top-32, so the pair would show up as two hubs with no route between them.
const carriers = [...airlineRoutes.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, CARRIER_LIMIT)
  .map(([code]) => code)
  .sort();
const carrierIndex = new Map(carriers.map((c, i) => [c, i]));

const servedDegree = new Map<string, number>();
for (const { airline, src, dst } of legs) {
  if (!carrierIndex.has(airline)) continue;
  servedDegree.set(src, (servedDegree.get(src) ?? 0) + 1);
  servedDegree.set(dst, (servedDegree.get(dst) ?? 0) + 1);
}

const candidates = [...servedDegree.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, AIRPORT_LIMIT)
  .map(([iata]) => iata);

// An airport can be busy overall yet have every one of its in-set routes land
// outside the set. Drop those: one pass is enough, since removing an airport
// with no edges cannot orphan another.
const candidateSet = new Set(candidates);
const inSetDegree = new Map<string, number>();
for (const { airline, src, dst } of legs) {
  if (!carrierIndex.has(airline)) continue;
  if (!candidateSet.has(src) || !candidateSet.has(dst)) continue;
  inSetDegree.set(src, (inSetDegree.get(src) ?? 0) + 1);
  inSetDegree.set(dst, (inSetDegree.get(dst) ?? 0) + 1);
}

const airports = candidates
  .filter((iata) => (inSetDegree.get(iata) ?? 0) > 0)
  .map((iata) => byIata.get(iata)!)
  .sort((a, b) => a.iata.localeCompare(b.iata));
const airportIndex = new Map(airports.map((a, i) => [a.iata, i]));

/** origin|dest -> bitmask of carriers that fly it. */
const routeMask = new Map<number, number>();
for (const { airline, src, dst } of legs) {
  const o = airportIndex.get(src);
  const d = airportIndex.get(dst);
  const c = carrierIndex.get(airline);
  if (o === undefined || d === undefined || c === undefined) continue;
  const key = o * 1000 + d;
  routeMask.set(key, (routeMask.get(key) ?? 0) | (1 << c));
}

const keys = [...routeMask.keys()].sort((a, b) => a - b);

const connected = new Set<number>();
for (const key of keys) { connected.add(Math.floor(key / 1000)); connected.add(key % 1000); }
const orphans = airports.filter((_, i) => !connected.has(i)).map((a) => a.iata);
if (orphans.length) throw new Error(`airports with no routes: ${orphans.join(', ')}`);
// 6 bytes per route: origin u8, dest u8, carrier mask u32.
const packed = new Uint8Array(keys.length * 6);
const view = new DataView(packed.buffer);
keys.forEach((key, i) => {
  const base = i * 6;
  packed[base] = Math.floor(key / 1000);
  packed[base + 1] = key % 1000;
  view.setUint32(base + 2, routeMask.get(key)!, true);
});
const b64 = Buffer.from(packed).toString('base64');

const out = `/**
 * GENERATED FILE — do not edit.
 *
 * Produced by scripts/fetch-routes.ts from the OpenFlights database
 * (https://openflights.org/data.html, Open Database License).
 *
 * ${airports.length} airports, ${carriers.length} airlines, ${keys.length} real routes between them.
 * Coordinates are genuine, so great-circle distance — and therefore flight
 * duration — is genuine too.
 */

export interface Airport {
  iata: string;
  city: string;
  lat: number;
  lon: number;
}

export const AIRPORTS: ReadonlyArray<Airport> = ${JSON.stringify(
  airports.map((a) => ({ iata: a.iata, city: a.city, lat: +a.lat.toFixed(4), lon: +a.lon.toFixed(4) })),
)};

export const CARRIERS: ReadonlyArray<string> = ${JSON.stringify(carriers)};

/** origin u8, dest u8, carrier bitmask u32 — little-endian, 6 bytes each. */
const PACKED_ROUTES = '${b64}';

export interface RouteTable {
  origin: Uint8Array;
  dest: Uint8Array;
  carrierMask: Uint32Array;
  length: number;
}

let cached: RouteTable | null = null;

/** Decoded once and shared; the table is read-only. */
export function routeTable(): RouteTable {
  if (cached) return cached;
  const binary = typeof atob === 'function'
    ? atob(PACKED_ROUTES)
    : Buffer.from(PACKED_ROUTES, 'base64').toString('binary');

  const count = binary.length / 6;
  const origin = new Uint8Array(count);
  const dest = new Uint8Array(count);
  const carrierMask = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const b = i * 6;
    origin[i] = binary.charCodeAt(b);
    dest[i] = binary.charCodeAt(b + 1);
    carrierMask[i] =
      (binary.charCodeAt(b + 2) |
        (binary.charCodeAt(b + 3) << 8) |
        (binary.charCodeAt(b + 4) << 16) |
        (binary.charCodeAt(b + 5) << 24)) >>> 0;
  }
  cached = { origin, dest, carrierMask, length: count };
  return cached;
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: Airport, b: Airport): number {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
`;

writeFileSync(join(ROOT, 'src/core/routes.ts'), out);
console.log(
  `wrote src/core/routes.ts — ${airports.length} airports, ${carriers.length} carriers, ` +
  `${keys.length} routes, ${(out.length / 1024).toFixed(0)}KB`,
);
