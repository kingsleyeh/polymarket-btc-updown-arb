/**
 * MARKET MAKER STRATEGY - Multi-Market
 *
 * Watches and trades BOTH markets simultaneously:
 *   - LIVE (≤15 min to expiry): Target 3% edge
 *   - PREMARKET (15-30 min to expiry): Target 2% edge
 *
 * Each market has independent state and can trade independently.
 * Once a position is filled on a market, hold until expiry.
 */
import { CategorizedMarket, MarketStrategy } from '../crypto/scanner';
interface MarketState {
    marketId: string;
    marketQuestion: string;
    upTokenId: string;
    downTokenId: string;
    upOrderId: string | null;
    downOrderId: string | null;
    upBidPrice: number;
    downBidPrice: number;
    upPosition: number;
    downPosition: number;
    status: 'IDLE' | 'QUOTING' | 'ONE_SIDED_UP' | 'ONE_SIDED_DOWN' | 'COMPLETE' | 'HOLDING' | 'AGGRESSIVE_COMPLETE';
    aggressiveCompleteOrderId: string | null;
    strategy: MarketStrategy;
    expiryTimestamp: number;
}
export declare function initializeMarketMaker(): Promise<boolean>;
export declare function addMarket(market: CategorizedMarket): Promise<void>;
export declare function removeExpiredMarkets(): void;
export declare function runMarketMakerLoop(): Promise<void>;
export declare function getActiveMarkets(): Map<string, MarketState>;
export declare function isAnyMarketHolding(): boolean;
export declare function printStats(): void;
export declare function stopMarketMaker(): void;
export {};
//# sourceMappingURL=market-maker.d.ts.map