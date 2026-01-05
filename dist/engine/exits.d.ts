/**
 * Exit Logic Module
 * Determines when to exit positions
 */
import { ActiveTrade, ExitDecision, ExitReason } from '../types/state';
import { HLTVMatchState } from '../types/hltv';
/**
 * Check if a position should be exited
 */
export declare function checkExit(trade: ActiveTrade, hltvState: HLTVMatchState): Promise<ExitDecision>;
/**
 * Get exit reason description
 */
export declare function getExitReasonDescription(reason: ExitReason): string;
//# sourceMappingURL=exits.d.ts.map