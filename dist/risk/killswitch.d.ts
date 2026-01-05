/**
 * Kill Switch Module
 * Handles emergency halts and trading suspensions
 */
export type KillSwitchReason = 'hltv_feed_stale' | 'polymarket_api_errors' | 'consecutive_losses' | 'max_drawdown' | 'manual';
/**
 * Check all kill switch conditions
 */
export declare function checkKillSwitch(): Promise<{
    triggered: boolean;
    reason?: KillSwitchReason;
    details?: string;
}>;
/**
 * Trigger kill switch and halt bot
 */
export declare function triggerKillSwitch(reason: KillSwitchReason, details?: string): void;
/**
 * Manual kill switch trigger
 */
export declare function manualKillSwitch(reason?: string): void;
/**
 * Run kill switch check and trigger if needed
 */
export declare function runKillSwitchCheck(): Promise<boolean>;
//# sourceMappingURL=killswitch.d.ts.map