/**
 * Polymarket Markets Module
 * Handles market discovery and price fetching using official APIs
 */
import { PolymarketMarket, PolymarketPrice, PolymarketOrderbook } from '../types/polymarket';
/**
 * Fetch all markets for a CS2 event
 */
export declare function fetchEventMarkets(eventId: string): Promise<PolymarketMarket[]>;
/**
 * Fetch current price for a market token
 */
export declare function fetchPrice(tokenId: string): Promise<PolymarketPrice>;
/**
 * Fetch orderbook for a market
 */
export declare function fetchOrderbook(tokenId: string): Promise<PolymarketOrderbook>;
/**
 * Calculate liquidity from orderbook
 */
export declare function calculateLiquidity(orderbook: PolymarketOrderbook): number;
/**
 * Find valid Map Winner market for current map
 */
export declare function findMapWinnerMarket(eventId: string, currentMapNumber: number): Promise<PolymarketMarket | null>;
/**
 * Check if market is open
 */
export declare function isMarketOpen(marketId: string): Promise<boolean>;
/**
 * Get best bid price for a token
 */
export declare function getBestBidPrice(tokenId: string): Promise<number | null>;
/**
 * Get best ask price for a token
 */
export declare function getBestAskPrice(tokenId: string): Promise<number | null>;
//# sourceMappingURL=markets.d.ts.map