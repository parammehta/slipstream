/**
 * Reading an arrival clock at the destination.
 *
 * The slab stores a local departure and an elapsed duration, and arrival is
 * their sum. That sum is a clock still running at the origin: on LAX-JFK it
 * is three hours fast, and a red-eye lands on the wrong date entirely. These
 * are what put it right.
 *
 * The correction cannot be a per-airport constant. LAX-JFK is three hours all
 * year because both ends keep DST, but LAX-PHX is one hour in January and
 * zero in July because Arizona does not, and LAX-HNL moves the other way. It
 * has to be read at the instants that actually matter.
 */
/** Reusing formatters matters: constructing one costs far more than a call. */
export type ZoneFormatters = Map<string, Intl.DateTimeFormat>;

/**
 * Minutes east of UTC for `zone` at `instant` (epoch milliseconds).
 *
 * Formatting the instant in the zone and reading the wall clock back is the
 * only way to get this from the platform; there is no offset API.
 */
export function zoneOffsetMinutes(
  zone: string,
  instant: number,
  formatters: ZoneFormatters = new Map(),
): number {
  let fmt = formatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    formatters.set(zone, fmt);
  }
  const parts = fmt.formatToParts(new Date(instant));
  const field = (type: string) => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  const wall = Date.UTC(
    field('year'), field('month') - 1, field('day'), field('hour'), field('minute'),
  );
  // The wall clock carries no seconds, so the raw difference includes up to
  // 59s of the instant's own; every real zone offset is a whole minute.
  return Math.round((wall - instant) / 60000);
}

/**
 * Minutes to add to a stored arrival so it reads at the destination.
 *
 * `depMinutesEpoch` is the departure as minutes since the Unix epoch on the
 * origin's own wall clock. Zero is returned when either zone is missing, so
 * an airport the table does not know shows the uncorrected clock rather than
 * a wrong one.
 */
export function arrivalShiftMinutes(
  from: string | undefined,
  to: string | undefined,
  depMinutesEpoch: number,
  durationMin: number,
  formatters: ZoneFormatters = new Map(),
): number {
  if (!from || !to || from === to) return 0;

  // The departure is a wall clock, so the instant it names depends on the very
  // offset being looked up. Reading it once at the naive instant and again at
  // the corrected one settles it everywhere except inside the hour a spring
  // change skips, which no real departure occupies.
  const naive = depMinutesEpoch * 60000;
  const approx = zoneOffsetMinutes(from, naive, formatters);
  const originOffset = zoneOffsetMinutes(from, naive - approx * 60000, formatters);
  const arrives = naive - originOffset * 60000 + durationMin * 60000;

  return zoneOffsetMinutes(to, arrives, formatters) - originOffset;
}

/**
 * Today as whole days since the Unix epoch, UTC.
 *
 * This is the corpus anchor. A generated corpus describes the next couple of
 * months of departures, so pinning it to a constant means that the day the
 * constant falls behind, the site starts offering flights in the past.
 */
export function todayEpochDay(): number {
  return Math.floor(Date.now() / 86_400_000);
}
