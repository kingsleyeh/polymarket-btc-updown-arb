"use strict";
/**
 * Paper Trading Simulator
 *
 * Simulates buy-and-hold arbitrage trades
 * NO real orders - paper trading only
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.simulateTrade = simulateTrade;
exports.getPaperTrades = getPaperTrades;
exports.getOpenTrades = getOpenTrades;
exports.settleExpiredTrades = settleExpiredTrades;
exports.getPaperStats = getPaperStats;
exports.resetPaperTrading = resetPaperTrading;
// Track all paper trades
const paperTrades = [];
// Running totals
let totalProfit = 0;
let totalTradesCount = 0;
/**
 * Simulate a paper trade for an arbitrage opportunity
 */
function simulateTrade(arb) {
    const now = Date.now();
    const trade = {
        id: `paper-${now}-${Math.random().toString(36).slice(2, 8)}`,
        arb_id: arb.id,
        market_id: arb.market_id,
        market_title: arb.market_title,
        up_price: arb.up_price,
        down_price: arb.down_price,
        combined_cost: arb.combined_cost,
        shares: arb.executable_shares,
        guaranteed_profit: arb.total_profit,
        entry_timestamp: now,
        expiry_timestamp: arb.expiry_timestamp,
        time_to_expiry_at_entry: arb.time_to_expiry_seconds,
        status: 'open',
    };
    // Track the trade
    paperTrades.push(trade);
    totalProfit += trade.guaranteed_profit;
    totalTradesCount++;
    return trade;
}
/**
 * Get all paper trades
 */
function getPaperTrades() {
    return [...paperTrades];
}
/**
 * Get open paper trades
 */
function getOpenTrades() {
    return paperTrades.filter(t => t.status === 'open');
}
/**
 * Settle expired trades
 */
function settleExpiredTrades() {
    const now = Date.now();
    const settled = [];
    for (const trade of paperTrades) {
        if (trade.status === 'open' && trade.expiry_timestamp <= now) {
            trade.status = 'settled';
            trade.settlement_timestamp = now;
            settled.push(trade);
        }
    }
    return settled;
}
/**
 * Get paper trading statistics
 */
function getPaperStats() {
    const openTrades = paperTrades.filter(t => t.status === 'open');
    const settledTrades = paperTrades.filter(t => t.status === 'settled');
    let totalTimeToExpiry = 0;
    for (const trade of paperTrades) {
        totalTimeToExpiry += trade.time_to_expiry_at_entry;
    }
    return {
        total_trades: totalTradesCount,
        open_trades: openTrades.length,
        settled_trades: settledTrades.length,
        total_profit: totalProfit,
        avg_profit_per_trade: totalTradesCount > 0 ? totalProfit / totalTradesCount : 0,
        avg_time_to_expiry: totalTradesCount > 0 ? totalTimeToExpiry / totalTradesCount : 0,
    };
}
/**
 * Reset paper trading (for testing)
 */
function resetPaperTrading() {
    paperTrades.length = 0;
    totalProfit = 0;
    totalTradesCount = 0;
}
//# sourceMappingURL=paper-trader.js.map