/**
 * MARKET MAKER STRATEGY
 *
 * Phase 1: Conservative market making with profit protection
 *
 * 1. Place bids for both UP and DOWN at prices that sum to TARGET_COMBINED
 * 2. Wait for fills
 * 3. If one side fills, aggressively complete the other side if still profitable
 * 4. If completing would be unprofitable, cut loss immediately
 */
export declare function initializeMarketMaker(): Promise<boolean>;
export declare function startMarketMaker(marketId: string, upTokenId: string, downTokenId: string, marketQuestion: string): Promise<void>;
export declare function printStats(): void;
export declare function stopMarketMaker(): void;
//# sourceMappingURL=market-maker.d.ts.map