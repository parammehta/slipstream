/**
 * A fare source.
 *
 * Providers differ in almost everything — bulk download versus paged API,
 * historical versus live, per-ticket versus per-market — so the contract is
 * deliberately narrow: hand back normalised fare observations and say where
 * they came from. Everything downstream (building the route table, modelling
 * schedules, writing the slab) is shared.
 */

export interface FareObservation {
  /** IATA code, uppercase. */
  origin: string;
  dest: string;
  /** Operating/marketing carrier, IATA. */
  carrier: string;
  /** One-way equivalent fare in US cents. */
  fareCents: number;
  /** Segments flown minus one; 0 is nonstop. */
  stops: number;
  /** Great-circle miles as reported by the source, where it reports them. */
  distanceMiles?: number;
  /**
   * How many tickets this observation stands for. DB1B is a 10% sample, so a
   * record with 3 passengers represents roughly 30 real tickets; weighting by
   * it stops a single odd itinerary carrying the same weight as a busy route.
   */
  passengers: number;
}

export interface HarvestContext {
  /** Where the provider may cache downloads between runs. */
  cacheDir: string;
  /** Called with human-readable progress; the CLI prints it. */
  log: (message: string) => void;
}

export interface ProviderRun {
  /** Identifies the vintage of the data, e.g. "2025 Q1". */
  period: string;
  /** Where the data came from, for attribution in the README and the UI. */
  attribution: string;
  /** Short description of the source file or endpoint, for the file header. */
  source: string;
  /** Aggregated markets, ready to publish. */
  markets: import('./market.ts').Market[];
  /** IATA -> city, for display. May be empty. */
  cities: Map<string, string>;
}

/**
 * Providers return markets rather than raw observations because the scale
 * varies by orders of magnitude: a bulk quarterly file holds tens of millions
 * of records and has to aggregate as it streams, while a paged API returns a
 * few thousand that `buildMarkets` can handle in one go. Both end up at the
 * same type.
 */

export interface HarvestProvider {
  readonly id: string;
  readonly name: string;
  /** True when the provider needs credentials the environment must supply. */
  readonly requiresCredentials: boolean;
  run(context: HarvestContext): Promise<ProviderRun>;
}

/**
 * Thrown when a provider is configured but cannot run; the CLI reports it.
 *
 * `hint` is assigned explicitly rather than declared as a constructor
 * parameter property: those cannot be erased by type stripping, and this
 * project runs TypeScript through Node directly rather than compiling it.
 */
export class HarvestError extends Error {
  hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'HarvestError';
    this.hint = hint;
  }
}
