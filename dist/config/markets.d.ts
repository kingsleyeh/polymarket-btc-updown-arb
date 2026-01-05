/**
 * Market Configuration
 * Market type definitions and validation
 */
import { PolymarketMarket } from '../types/polymarket';
export declare const MARKET_TYPE_MAP_WINNER = "Map Winner";
/**
 * Check if a market is a valid Map Winner market for trading
 */
export declare function isValidMapWinnerMarket(market: PolymarketMarket, currentMapNumber: number): boolean;
/**
 * Filter markets to get valid Map Winner markets for current map
 */
export declare function filterMapWinnerMarkets(markets: PolymarketMarket[], currentMapNumber: number): PolymarketMarket[];
/**
 * Extract map number from market question if available
 * Expected format: "Who will win Map X?"
 */
export declare function extractMapNumberFromQuestion(question: string): number | null;
/**
 * Match HLTV team names to Polymarket market teams
 * Returns the token ID for the matched team
 */
export declare function matchTeamToToken(market: PolymarketMarket, teamName: string): string | null;
//# sourceMappingURL=markets.d.ts.map