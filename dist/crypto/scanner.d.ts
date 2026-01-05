/**
 * BTC Up/Down 15-Minute Market Scanner
 *
 * Finds ONLY the CURRENT BTC 15-minute Up/Down market on Polymarket
 * Series 10192 = Bitcoin 15-minute markets
 */
import { UpDownMarket } from '../types/arbitrage';
/**
 * Scan for the CURRENT BTC 15-minute Up/Down market only
 */
export declare function scanBTCUpDownMarkets(): Promise<UpDownMarket[]>;
/**
 * Get market summary
 */
export declare function getMarketSummary(markets: UpDownMarket[]): {
    total: number;
    expiring_soon: number;
    avg_time_to_expiry: number;
};
//# sourceMappingURL=scanner.d.ts.map