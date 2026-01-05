"use strict";
/**
 * Persistence Tracking
 *
 * Tracks how long arbitrage opportunities persist before disappearing
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordClosedArb = recordClosedArb;
exports.createActiveArbEntry = createActiveArbEntry;
exports.getClosedArbs = getClosedArbs;
exports.getPersistenceStats = getPersistenceStats;
exports.clearPersistenceData = clearPersistenceData;
// Track closed arbs for analysis
const closedArbs = [];
/**
 * Record a closed arbitrage opportunity
 */
function recordClosedArb(arb, reason) {
    const persistenceSec = (arb.last_seen_at - arb.first_detected_at) / 1000;
    const entry = {
        timestamp: new Date(arb.first_detected_at).toISOString(),
        market_id: arb.market_id,
        market_title: arb.market_title,
        expiry_timestamp: arb.expiry_timestamp,
        up_price: arb.up_price,
        down_price: arb.down_price,
        combined_cost: arb.combined_cost,
        simulated_shares: arb.executable_shares,
        guaranteed_profit: arb.total_profit,
        up_liquidity: arb.up_shares_available,
        down_liquidity: arb.down_shares_available,
        time_to_expiry_at_entry: arb.time_to_expiry_seconds,
        persistence_duration_sec: persistenceSec,
        scan_cycles_observed: arb.consecutive_cycles,
        disappearance_reason: reason,
    };
    closedArbs.push(entry);
    return entry;
}
/**
 * Create entry for still-active arb (for final logging)
 */
function createActiveArbEntry(arb) {
    const persistenceSec = (arb.last_seen_at - arb.first_detected_at) / 1000;
    return {
        timestamp: new Date(arb.first_detected_at).toISOString(),
        market_id: arb.market_id,
        market_title: arb.market_title,
        expiry_timestamp: arb.expiry_timestamp,
        up_price: arb.up_price,
        down_price: arb.down_price,
        combined_cost: arb.combined_cost,
        simulated_shares: arb.executable_shares,
        guaranteed_profit: arb.total_profit,
        up_liquidity: arb.up_shares_available,
        down_liquidity: arb.down_shares_available,
        time_to_expiry_at_entry: arb.time_to_expiry_seconds,
        persistence_duration_sec: persistenceSec,
        scan_cycles_observed: arb.consecutive_cycles,
        disappearance_reason: 'still_active',
    };
}
/**
 * Get all closed arbs
 */
function getClosedArbs() {
    return [...closedArbs];
}
/**
 * Get persistence statistics
 */
function getPersistenceStats() {
    if (closedArbs.length === 0) {
        return {
            total_arbs: 0,
            avg_duration_sec: 0,
            max_duration_sec: 0,
            min_duration_sec: 0,
            avg_cycles: 0,
            by_reason: {},
        };
    }
    const durations = closedArbs.map(a => a.persistence_duration_sec);
    const cycles = closedArbs.map(a => a.scan_cycles_observed);
    const byReason = {};
    for (const arb of closedArbs) {
        const reason = arb.disappearance_reason || 'unknown';
        byReason[reason] = (byReason[reason] || 0) + 1;
    }
    return {
        total_arbs: closedArbs.length,
        avg_duration_sec: durations.reduce((a, b) => a + b, 0) / durations.length,
        max_duration_sec: Math.max(...durations),
        min_duration_sec: Math.min(...durations),
        avg_cycles: cycles.reduce((a, b) => a + b, 0) / cycles.length,
        by_reason: byReason,
    };
}
/**
 * Clear persistence data
 */
function clearPersistenceData() {
    closedArbs.length = 0;
}
//# sourceMappingURL=persistence.js.map