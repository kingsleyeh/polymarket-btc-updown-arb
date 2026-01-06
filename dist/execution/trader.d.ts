/**
 * ORDER BOOK AWARE EXECUTION
 *
 * 1. Fetch real order book to get exact ask prices
 * 2. Place orders at actual ask (instant fill)
 * 3. Fast polling (500ms) with early exit
 *
 * No blind buffers - we know exactly what we're paying
 */
import { ArbitrageOpportunity } from '../types/arbitrage';
interface ExecutedTrade {
    id: string;
    market_id: string;
    shares: number;
    cost: number;
    status: 'filled' | 'failed';
    has_exposure: boolean;
    can_retry: boolean;
    error?: string;
}
export declare function canTradeMarket(marketId: string): boolean;
export declare function initializeTrader(): Promise<boolean>;
/**
 * MAIN EXECUTION - Order Book Aware
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