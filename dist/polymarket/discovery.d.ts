/**
 * Polymarket Market Discovery
 * Automatically finds CS2 markets on Polymarket using Gamma API
 */
import { PolymarketMarket } from '../types/polymarket';
interface GammaEvent {
    id: string;
    slug: string;
    title: string;
    description: string;
    active: boolean;
    closed: boolean;
    markets: GammaMarket[];
}
interface GammaMarket {
    id: string;
    conditionId: string;
    question: string;
    marketType: string;
    active: boolean;
    closed: boolean;
    outcomes: string[];
    clobTokenIds: string[];
    liquidity: string;
}
/**
 * Search Polymarket for CS2/Counter-Strike events
 */
export declare function findCS2Events(): Promise<GammaEvent[]>;
/**
 * Match HLTV match to Polymarket market
 * Uses team names to find corresponding market
 */
export declare function findMarketForMatch(team1: string, team2: string): Promise<{
    eventId: string;
    market: PolymarketMarket;
} | null>;
/**
 * Get all active CS2 Map Winner markets
 */
export declare function getAllActiveMapWinnerMarkets(): Promise<Array<{
    eventId: string;
    market: PolymarketMarket;
    teams: string[];
}>>;
export {};
//# sourceMappingURL=discovery.d.ts.map