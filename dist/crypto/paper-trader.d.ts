/**
 * Paper Trading Simulator
 *
 * Simulates buy-and-hold arbitrage trades
 * NO real orders - paper trading only
 */
import { ArbitrageOpportunity, PaperTrade } from '../types/arbitrage';
/**
 * Simulate a paper trade for an arbitrage opportunity
 */
export declare function simulateTrade(arb: ArbitrageOpportunity): PaperTrade;
/**
 * Get all paper trades
 */
export declare function getPaperTrades(): PaperTrade[];
/**
 * Get open paper trades
 */
export declare function getOpenTrades(): PaperTrade[];
/**
 * Settle expired trades
 */
export declare function settleExpiredTrades(): PaperTrade[];
/**
 * Get paper trading statistics
 */
export declare function getPaperStats(): {
    total_trades: number;
    open_trades: number;
    settled_trades: number;
    total_profit: number;
    avg_profit_per_trade: number;
    avg_time_to_expiry: number;
};
/**
 * Reset paper trading (for testing)
 */
export declare function resetPaperTrading(): void;
//# sourceMappingURL=paper-trader.d.ts.map