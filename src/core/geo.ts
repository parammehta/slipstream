/**
 * Guessing where the visitor is, without asking and without a server.
 *
 * The obvious options both cost something this design is not willing to pay.
 * An IP lookup means either a request to a third party — handing them the
 * visitor's address on every page view — or a function of our own, which puts
 * a server back on a path that deliberately has none. The browser's
 * geolocation API is accurate but interrupts a first visit with a permission
 * prompt most people decline.
 *
 * The timezone is already in the page. `Intl` reports an IANA zone with no
 * request, no prompt and nothing disclosed, and for picking which airport to
 * start from it is good enough: a zone pins a region, and the nearest airport
 * in that region is a far better opening guess than a fixed default.
 *
 * It is a guess, and the page says so rather than pretending to know.
 */

export interface Position {
  lat: number;
  lon: number;
}

export interface LocatableAirport {
  iata: string;
  lat?: number;
  lon?: number;
}

/**
 * A representative position per IANA zone, for the regions this dataset
 * covers. Anywhere else returns nothing: the corpus is US domestic, so
 * guessing a departure airport for a visitor in Berlin would be noise
 * dressed up as personalisation.
 */
const ZONE_POSITIONS: Record<string, Position> = {
  'America/New_York': { lat: 40.71, lon: -74.01 },
  'America/Detroit': { lat: 42.33, lon: -83.05 },
  'America/Chicago': { lat: 41.88, lon: -87.63 },
  'America/Denver': { lat: 39.74, lon: -104.99 },
  'America/Boise': { lat: 43.62, lon: -116.2 },
  'America/Phoenix': { lat: 33.45, lon: -112.07 },
  'America/Los_Angeles': { lat: 34.05, lon: -118.24 },
  'America/Anchorage': { lat: 61.22, lon: -149.9 },
  'America/Juneau': { lat: 58.3, lon: -134.42 },
  'America/Sitka': { lat: 57.05, lon: -135.33 },
  'America/Nome': { lat: 64.5, lon: -165.41 },
  'America/Adak': { lat: 51.88, lon: -176.66 },
  'Pacific/Honolulu': { lat: 21.31, lon: -157.86 },
  'America/Menominee': { lat: 45.11, lon: -87.61 },
  'America/Puerto_Rico': { lat: 18.47, lon: -66.11 },
  'America/Toronto': { lat: 43.65, lon: -79.38 },
  'America/Vancouver': { lat: 49.28, lon: -123.12 },
  'America/Edmonton': { lat: 53.55, lon: -113.49 },
  'America/Winnipeg': { lat: 49.9, lon: -97.14 },
  'America/Halifax': { lat: 44.65, lon: -63.58 },
};

/** Zones that subdivide a state all sit near the same place for our purposes. */
const ZONE_PREFIXES: Array<[string, Position]> = [
  ['America/Indiana/', { lat: 39.77, lon: -86.16 }],
  ['America/Kentucky/', { lat: 38.25, lon: -85.76 }],
  ['America/North_Dakota/', { lat: 46.81, lon: -100.78 }],
];

/** Approximate position for an IANA time zone, or null when unknown. */
export function positionForTimeZone(zone: string | undefined | null): Position | null {
  if (!zone) return null;
  const exact = ZONE_POSITIONS[zone];
  if (exact) return exact;
  for (const [prefix, position] of ZONE_PREFIXES) {
    if (zone.startsWith(prefix)) return position;
  }
  return null;
}

/** The viewer's zone, where the environment reports one. */
export function currentTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch (_) {
    return null;
  }
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: Position, b: Position): number {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface NearestResult {
  iata: string;
  km: number;
}

/** Closest airport to a position, ignoring any whose position is unknown. */
export function nearestAirport(
  from: Position,
  airports: ReadonlyArray<LocatableAirport>,
): NearestResult | null {
  let best: NearestResult | null = null;
  for (const airport of airports) {
    if (airport.lat === undefined || airport.lon === undefined) continue;
    const km = distanceKm(from, { lat: airport.lat, lon: airport.lon });
    if (!best || km < best.km) best = { iata: airport.iata, km };
  }
  return best;
}

/**
 * The airport to open on, given where the visitor's clock says they are.
 *
 * `maxKm` is roughly how far someone would travel to a departure airport. It
 * matters at the edges of the data: Halifax resolves to a position, but its
 * nearest US airport is Boston at 650km, which nobody in Halifax is driving
 * to. Past the radius the guess is withheld and the default stands.
 */
export function suggestOrigin(
  airports: ReadonlyArray<LocatableAirport>,
  zone = currentTimeZone(),
  maxKm = 500,
): NearestResult | null {
  const here = positionForTimeZone(zone);
  if (!here) return null;
  const nearest = nearestAirport(here, airports);
  return nearest && nearest.km <= maxKm ? nearest : null;
}
