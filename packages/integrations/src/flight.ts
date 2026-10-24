/**
 * Flight status provider abstraction (TZ §4.1, §13.4). Version 1 ships only the manual provider:
 * the manager checks the airline/airport source and records the result. A manual result is never
 * presented as live API data.
 */

export interface FlightStatusQuery {
  carrier: string;
  flightNumber: string;
  departureDateLocal: string;
  originIata: string;
}

export interface FlightStatusResult {
  source: string;
  live: boolean;
  departureAtUtc: Date | null;
  status: 'scheduled' | 'schedule_changed' | 'cancelled' | 'unknown';
  terminal: string | null;
}

export interface FlightProvider {
  readonly name: string;
  readonly live: boolean;
  /** Manual provider returns null: the result must be entered by a person. */
  lookup(query: FlightStatusQuery): Promise<FlightStatusResult | null>;
}

export class ManualFlightProvider implements FlightProvider {
  readonly name = 'manual';
  readonly live = false;
  async lookup(): Promise<null> {
    return null;
  }
}
