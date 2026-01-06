/**
 * BTC Up/Down Arbitrage Detection
 *
 * Detects opportunities where:
 * buy_up_price + buy_down_price < 1.00 - MIN_EDGE
 *
 * Uses WebSocket cache for instant price access
 */
import { UpDownMarket, MarketPrices, ArbitrageOpportunity } from '../types/arbitrage';
/**
 * Fetch current prices for a market
 * PRIORITY: WebSocket cache (instant) → REST fallback
 */
export declare function fetchMarketPrices(market: UpDownMarket): Promise<MarketPrices | null>;
/**
 * Check if arbitrage opportunity exists
 *
 * Arb condition: up_price + down_price < 1.00 - MIN_EDGE
 */
export declare function checkArbitrage(market: UpDownMarket, prices: MarketPrices): ArbitrageOpportunity | null;
/**
 * Update existing arbitrage tracking or create new
 */
export declare function updateArbTracking(marketId: string, newArb: ArbitrageOpportunity | null, prices: MarketPrices | null): {
    arb: ArbitrageOpportunity | null;
    status: 'new' | 'updated' | 'closed' | 'none';
    closedArb?: ArbitrageOpportunity;
    closeReason?: 'price_moved' | 'liquidity_exhausted' | 'expiry_cutoff';
};
/**
 * Get all active arbitrage opportunities
 */
export declare function getActiveArbs(): ArbitrageOpportunity[];
/**
 * Clear all tracked arbs
 */
export declare function clearArbs(): void;
/**
 * Get persistence duration in seconds
 */
export declare function getArbPersistence(arb: ArbitrageOpportunity): number;
//# sourceMappingURL=arbitrage.d.ts.map