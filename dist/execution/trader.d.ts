/**
 * Trade Execution with Smart Retry
 *
 * RULES:
 * 1. 0 UP, 0 DOWN → can retry (no exposure)
 * 2. X UP = X DOWN → success (done)
 * 3. X UP ≠ Y DOWN → STOP (has exposure, manual fix needed)
 */
import { ArbitrageOpportunity } from '../types/arbitrage';
interface ExecutedTrade {
    id: string;
    market_id: string;
    shares: number;
    status: 'filled' | 'failed';
    has_exposure: boolean;
    can_retry: boolean;
    error?: string;
}
/**
 * Check if market can be traded
 * Returns: true if we can attempt, false if blocked
 */
export declare function canTradeMarket(marketId: string): boolean;
/**
 * Initialize trader
 */
export declare function initializeTrader(): Promise<boolean>;
/**
 * Execute trade - with smart retry logic
 */
export declare function executeTrade(arb: ArbitrageOpportunity): Promise<ExecutedTrade | null>;
export declare function getExecutionStats(): {
    total_trades: number;
    successful_trades: number;
    failed_trades: number;
    total_cost: number;
    total_profit: number;
    pending_payout: number;
};
export declare function isTraderReady(): boolean;
export declare function getBalance(): Promise<number>;
export {};
//# sourceMappingURL=trader.d.ts.map