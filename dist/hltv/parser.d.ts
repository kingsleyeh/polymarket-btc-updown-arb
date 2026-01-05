/**
 * HLTV Response Parser
 * Utility functions for HLTV match state
 */
import { HLTVMatchState } from '../types/hltv';
/**
 * Calculate score difference
 */
export declare function getScoreDifference(state: HLTVMatchState): number;
/**
 * Check if it's a pistol round (round 1 or 16)
 */
export declare function isPistolRound(roundNumber: number): boolean;
/**
 * Check if team is at map point (12 rounds)
 */
export declare function isAtMapPoint(state: HLTVMatchState): 'team_a' | 'team_b' | null;
/**
 * Check if match is in overtime
 */
export declare function isOvertime(state: HLTVMatchState): boolean;
/**
 * Get the leading team
 */
export declare function getLeadingTeam(state: HLTVMatchState): 'team_a' | 'team_b' | null;
/**
 * Validate that match state has all required fields
 */
export declare function isValidMatchState(state: Partial<HLTVMatchState>): state is HLTVMatchState;
/**
 * Check if round is a half-switch round (round 13)
 */
export declare function isHalfTime(roundNumber: number): boolean;
/**
 * Get total rounds played
 */
export declare function getTotalRoundsPlayed(state: HLTVMatchState): number;
/**
 * Check if a team has won the map (13 rounds in regulation)
 */
export declare function hasTeamWonMap(state: HLTVMatchState): 'team_a' | 'team_b' | null;
//# sourceMappingURL=parser.d.ts.map