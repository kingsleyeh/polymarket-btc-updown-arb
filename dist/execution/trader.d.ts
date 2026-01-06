/**
 * Real Trade Execution - SEQUENTIAL STRATEGY
 *
 * NEW APPROACH: DOWN first, then UP
 * - Place DOWN order first (historically harder to fill)
 * - Wait for DOWN to fill
 * - ONLY then place UP order
 * - If DOWN doesn't fill, cancel and retry (no exposure)
 * - If DOWN fills but UP doesn't, we have DOWN exposure (report it)
 */
import { ArbitrageOpportunity } from '../types/arbitrage';
interface ExecutedTrade {
    id: string;
    market_id: string;
    market_title: string;
    up_order_id: string | null;
    down_order_id: string | null;
    up_price: number;
    down_price: number;
    combined_cost: number;
    shares: number;
    cost_usd: number;
    guaranteed_payout: number;
    profit_usd: number;
    timestamp: number;
    expiry_timestamp: number;
    status: 'pending' | 'filled' | 'partial' | 'failed';
    error?: string;
    orders_placed: boolean;
    reversal_succeeded: boolean;
    has_exposure: boolean;
}
/**
 * Initialize the CLOB client with wallet
 */
export declare function initializeTrader(): Promise<boolean>;
/**
 * Get current balance (cached)
 */
export declare function getBalance(): Promise<number>;
/**
 * Execute arbitrage trade - SEQUENTIAL: DOWN first, then UP
 */
export declare function executeTrade(arb: ArbitrageOpportunity): Promise<ExecutedTrade | null>;
/**
 * Get all executed trades
 */
export declare function getExecutedTrades(): ExecutedTrade[];
/**
 * Get execution stats
 */
export declare function getExecutionStats(): {
    total_trades: number;
    successful_trades: number;
    failed_trades: number;
    total_cost: number;
    total_profit: number;
    pending_payout: number;
};
/**
 * Check if trader is ready
 */
export declare function isTraderReady(): boolean;
export {};
//# sourceMappingURL=trader.d.ts.map