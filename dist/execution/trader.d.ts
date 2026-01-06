/**
 * ORDER BOOK AWARE EXECUTION with WebSocket
 *
 * 1. Real-time order book via WebSocket (no fetch latency)
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
 * Subscribe to order book updates for market tokens
 */
export declare function subscribeToMarketOrderBooks(upTokenId: string, downTokenId: string): void;
/**
 * MAIN EXECUTION - Order Book Aware with WebSocket
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
export declare function shutdownTrader(): void;
export {};
//# sourceMappingURL=trader.d.ts.map