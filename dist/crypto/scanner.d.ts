/**
 * BTC Up/Down 15-Minute Market Scanner
 *
 * Scans for BTC 15-minute Up/Down markets on Polymarket
 * Returns up to 2 markets:
 *   - CURRENT (live): ≤15 min to expiry
 *   - NEXT (pre-market): 15-30 min to expiry
 *
 * Series 10192 = Bitcoin 15-minute markets
 */
import { UpDownMarket } from '../types/arbitrage';
export type MarketStrategy = 'LIVE' | 'PREMARKET';
export interface CategorizedMarket extends UpDownMarket {
    strategy: MarketStrategy;
    timeToExpirySec: number;
}
/**
 * Scan for the CURRENT BTC 15-minute Up/Down market only
 */
export declare function scanBTCUpDownMarkets(): Promise<UpDownMarket[]>;
/**
 * Scan for markets with strategy categorization
 * Returns up to 2 markets: LIVE (≤15min) and PREMARKET (15-30min)
 */
export declare function scanMarketsWithStrategy(): Promise<CategorizedMarket[]>;
/**
 * Get market summary
 */
export declare function getMarketSummary(markets: UpDownMarket[]): {
    total: number;
    expiring_soon: number;
    avg_time_to_expiry: number;
};
//# sourceMappingURL=scanner.d.ts.map