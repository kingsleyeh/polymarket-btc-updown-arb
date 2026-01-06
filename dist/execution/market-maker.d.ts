/**
 * MARKET MAKER STRATEGY
 *
 * Two strategies based on market timing:
 *
 * PREMARKET (15-30 min to expiry):
 *   - Lower volatility, liquidity trickling in
 *   - Target 2% edge
 *   - If one leg fills when market goes live (15 min mark), risk management kicks in
 *
 * LIVE (≤15 min to expiry):
 *   - Active market
 *   - Target 3% edge
 *   - Standard risk management
 *
 * Both strategies:
 *   1. Place bids for both UP and DOWN at prices that sum to TARGET_COMBINED
 *   2. Wait for fills
 *   3. If one side fills, aggressively complete the other side if still profitable
 *   4. If completing would be unprofitable, cut loss immediately
 *   5. Once both sides filled, HOLD until expiry - NO MORE TRADING
 *
 * Volatility filter:
 *   - Skip if UP >= 80¢ OR DOWN >= 80¢
 */
import { CategorizedMarket, MarketStrategy } from '../crypto/scanner';
interface MarketMakerState {
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
    status: 'IDLE' | 'QUOTING' | 'ONE_SIDED_UP' | 'ONE_SIDED_DOWN' | 'COMPLETE' | 'BLOCKED' | 'AGGRESSIVE_COMPLETE' | 'HOLDING';
    aggressiveCompleteOrderId: string | null;
    strategy: MarketStrategy;
    expiryTimestamp: number;
    totalPnL: number;
    tradesCompleted: number;
    tradesCut: number;
}
export declare function initializeMarketMaker(): Promise<boolean>;
export declare function startMarketMaker(market: CategorizedMarket): Promise<void>;
export declare function printStats(): void;
export declare function getMarketState(): MarketMakerState | null;
export declare function isHolding(): boolean;
export declare function stopMarketMaker(): void;
export declare function startMarketMakerForMarket(market: CategorizedMarket): Promise<void>;
export {};
//# sourceMappingURL=market-maker.d.ts.map