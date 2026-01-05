/**
 * Real Trade Execution - Optimized
 *
 * Features:
 * - Parallel order execution
 * - Dynamic sizing (% of balance)
 * - Liquidity-aware (don't move the market)
 * - Slippage protection
 * - Price verification before execution
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
 * Execute arbitrage trade - buy both Up and Down in PARALLEL
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