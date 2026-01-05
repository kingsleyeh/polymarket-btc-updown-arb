/**
 * HLTV Match Discovery
 * Automatically finds live CS2 matches
 */
export interface LiveMatch {
    id: number;
    team1: string;
    team2: string;
    event: string;
    maps: number;
    stars: number;
}
/**
 * Get all currently live CS2 matches from HLTV
 */
export declare function getLiveMatches(): Promise<LiveMatch[]>;
/**
 * Get upcoming matches (for pre-positioning)
 */
export declare function getUpcomingMatches(): Promise<LiveMatch[]>;
/**
 * Find high-priority matches (higher star rating = bigger matches)
 */
export declare function prioritizeMatches(matches: LiveMatch[]): LiveMatch[];
//# sourceMappingURL=discovery.d.ts.map