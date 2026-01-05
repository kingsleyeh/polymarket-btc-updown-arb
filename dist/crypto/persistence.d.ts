/**
 * Persistence Tracking
 *
 * Tracks how long arbitrage opportunities persist before disappearing
 */
import { ArbitrageOpportunity, ArbitrageLogEntry } from '../types/arbitrage';
/**
 * Record a closed arbitrage opportunity
 */
export declare function recordClosedArb(arb: ArbitrageOpportunity, reason: 'price_moved' | 'liquidity_exhausted' | 'expiry_cutoff'): ArbitrageLogEntry;
/**
 * Create entry for still-active arb (for final logging)
 */
export declare function createActiveArbEntry(arb: ArbitrageOpportunity): ArbitrageLogEntry;
/**
 * Get all closed arbs
 */
export declare function getClosedArbs(): ArbitrageLogEntry[];
/**
 * Get persistence statistics
 */
export declare function getPersistenceStats(): {
    total_arbs: number;
    avg_duration_sec: number;
    max_duration_sec: number;
    min_duration_sec: number;
    avg_cycles: number;
    by_reason: Record<string, number>;
};
/**
 * Clear persistence data
 */
export declare function clearPersistenceData(): void;
//# sourceMappingURL=persistence.d.ts.map