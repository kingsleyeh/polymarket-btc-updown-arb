/**
 * Tournament Configuration
 * Defines which tournaments/events to monitor
 */
export interface TournamentConfig {
    id: string;
    name: string;
    polymarket_event_id?: string;
    hltv_event_id?: string;
    enabled: boolean;
}
export declare const TOURNAMENTS: TournamentConfig[];
/**
 * Get enabled tournaments
 */
export declare function getEnabledTournaments(): TournamentConfig[];
/**
 * Find tournament by HLTV event ID
 */
export declare function findTournamentByHLTVId(hltvEventId: string): TournamentConfig | undefined;
/**
 * Find tournament by Polymarket event ID
 */
export declare function findTournamentByPolymarketId(polymarketEventId: string): TournamentConfig | undefined;
//# sourceMappingURL=tournaments.d.ts.map