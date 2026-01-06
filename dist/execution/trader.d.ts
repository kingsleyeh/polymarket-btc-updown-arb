/**
 * SIMPLIFIED Trade Execution
 *
 * 1. Market buy both sides IMMEDIATELY
 * 2. Auto-reverse any imbalance
 * 3. Retry until success or manual intervention needed
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
 */
export declare function canTradeMarket(marketId: string): boolean;
/**
 * Initialize trader
 */
export declare function initializeTrader(): Promise<boolean>;
/**
 * Execute trade - SIMPLE VERSION
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