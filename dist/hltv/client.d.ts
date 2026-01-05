/**
 * HLTV Client
 * Handles live match data from HLTV using the hltv npm package
 */
import { HLTVMatchState } from '../types/hltv';
interface MatchInfo {
    id: number;
    team1: {
        id: number;
        name: string;
    };
    team2: {
        id: number;
        name: string;
    };
    maps: Array<{
        name: string;
        result?: {
            team1: number;
            team2: number;
        };
    }>;
}
export declare class HLTVClient {
    private currentMatchState;
    private isConnected;
    private matchInfo;
    private currentMapNumber;
    private team1IsCT;
    private disconnectFn;
    constructor();
    /**
     * Start listening to live match data via scorebot
     */
    startPolling(matchId: string): Promise<void>;
    /**
     * Handle scorebot scoreboard updates
     */
    private handleScorebotUpdate;
    /**
     * Handle scorebot log updates (round events)
     */
    private handleLogUpdate;
    /**
     * Stop listening to scorebot
     */
    stopPolling(): void;
    /**
     * Fetch match info (for initial setup)
     */
    fetchMatchState(matchId: string): Promise<HLTVMatchState | null>;
    /**
     * Get current match state
     */
    getMatchState(): HLTVMatchState | null;
    /**
     * Check if feed is fresh (within FEED_STALE_MS)
     */
    isFeedFresh(): boolean;
    /**
     * Get feed staleness in milliseconds
     */
    getFeedStaleness(): number;
    /**
     * Check if match is live and not paused
     */
    isMatchActive(): boolean;
    /**
     * Check if connected to scorebot
     */
    isConnectedToScorebot(): boolean;
    /**
     * Get last update timestamp
     */
    getLastUpdateTimestamp(): number;
    /**
     * Set current map number (called when map changes)
     */
    setCurrentMapNumber(mapNumber: number): void;
    /**
     * Get match info
     */
    getMatchInfo(): MatchInfo | null;
    /**
     * Get team names
     */
    getTeamNames(): {
        team_a: string;
        team_b: string;
    } | null;
}
export declare function getHLTVClient(): HLTVClient;
export {};
//# sourceMappingURL=client.d.ts.map