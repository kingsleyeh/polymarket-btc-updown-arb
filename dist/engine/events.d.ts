/**
 * Event Detection Module
 * Detects tradeable events from HLTV state changes
 */
import { HLTVMatchState } from '../types/hltv';
import { TriggerType } from '../types/state';
export interface DetectedEvent {
    type: TriggerType;
    team: 'team_a' | 'team_b';
    round_number: number;
    timestamp: number;
}
/**
 * Detect events from state change
 */
export declare function detectEvents(matchId: string, currentState: HLTVMatchState): DetectedEvent[];
/**
 * Clear event context for a match
 */
export declare function clearEventContext(matchId: string): void;
/**
 * Reset all event contexts
 */
export declare function resetAllEventContexts(): void;
//# sourceMappingURL=events.d.ts.map