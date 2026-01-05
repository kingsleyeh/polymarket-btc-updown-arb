/**
 * Polymarket Balance Module
 * Handles balance queries using official SDK and Data API
 */
import { PolymarketBalance } from '../types/polymarket';
/**
 * Fetch current balance from Polymarket
 * Tries multiple methods to get balance
 */
export declare function fetchBalance(): Promise<PolymarketBalance>;
/**
 * Get available balance for trading
 */
export declare function getAvailableBalance(): Promise<number>;
/**
 * Get total balance
 */
export declare function getTotalBalance(): Promise<number>;
/**
 * Get locked balance
 */
export declare function getLockedBalance(): Promise<number>;
/**
 * Calculate trade size based on available balance and position size percent
 */
export declare function calculateTradeSize(positionSizePercent: number): Promise<number>;
/**
 * Check if sufficient balance exists for a trade
 */
export declare function hasSufficientBalance(requiredAmount: number): Promise<boolean>;
//# sourceMappingURL=balance.d.ts.map