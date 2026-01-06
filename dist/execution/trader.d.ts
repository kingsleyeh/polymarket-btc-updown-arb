/**
 * SIMPLE LIMIT ORDER EXECUTION
 *
 * Place both orders, wait for fills, verify positions
 * No FAK, no race conditions, no stale position checks
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
export declare function canTradeMarket(marketId: string): boolean;
export declare function initializeTrader(): Promise<boolean>;
/**
 * MAIN EXECUTION
 *
 * 1. Place BOTH limit orders simultaneously at detected prices
 * 2. Wait for fills
 * 3. Verify final positions match
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