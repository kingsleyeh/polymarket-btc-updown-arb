/**
 * SEQUENTIAL Execution - ONLY way to guarantee UP = DOWN
 *
 * 1. Place DOWN order, wait for fill
 * 2. Check EXACTLY how many DOWN we got
 * 3. Place UP order for EXACTLY that amount
 * 4. If imbalanced, reverse to 0
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
 * SEQUENTIAL EXECUTE - Guarantees UP = DOWN
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