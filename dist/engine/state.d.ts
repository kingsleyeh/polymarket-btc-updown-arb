/**
 * Bot State Management
 * Centralized state for the trading bot
 */
import { BotState, ActiveTrade, MatchContext } from '../types/state';
/**
 * Initialize bot state
 */
export declare function initializeState(initialBalance: number): void;
/**
 * Get current bot state
 */
export declare function getState(): BotState;
/**
 * Update balance and track peak
 */
export declare function updateBalance(newBalance: number): void;
/**
 * Set bot running state
 */
export declare function setRunning(running: boolean): void;
/**
 * Halt the bot
 */
export declare function haltBot(reason: string): void;
/**
 * Resume bot after cooldown
 */
export declare function resumeBot(): void;
/**
 * Set cooldown period
 */
export declare function setCooldown(durationMs: number): void;
/**
 * Check if in cooldown period
 */
export declare function isInCooldown(): boolean;
/**
 * Increment consecutive losses
 */
export declare function incrementLosses(): void;
/**
 * Reset consecutive losses
 */
export declare function resetLosses(): void;
/**
 * Get consecutive losses count
 */
export declare function getConsecutiveLosses(): number;
/**
 * Add active trade
 */
export declare function addActiveTrade(trade: ActiveTrade): void;
/**
 * Remove active trade
 */
export declare function removeActiveTrade(tradeId: string): void;
/**
 * Get active trade by ID
 */
export declare function getActiveTrade(tradeId: string): ActiveTrade | undefined;
/**
 * Get all active trades
 */
export declare function getActiveTrades(): ActiveTrade[];
/**
 * Get active trades for a specific match/map
 */
export declare function getActiveTradesForMap(matchId: string, mapNumber: number): ActiveTrade[];
/**
 * Update active trade
 */
export declare function updateActiveTrade(tradeId: string, updates: Partial<ActiveTrade>): void;
/**
 * Set or update match context
 */
export declare function setMatchContext(matchId: string, context: MatchContext): void;
/**
 * Get match context
 */
export declare function getMatchContext(matchId: string): MatchContext | undefined;
/**
 * Remove match context
 */
export declare function removeMatchContext(matchId: string): void;
/**
 * Update HLTV timestamp
 */
export declare function updateHLTVTimestamp(timestamp: number): void;
/**
 * Update Polymarket timestamp
 */
export declare function updatePolymarketTimestamp(timestamp: number): void;
/**
 * Check if bot can trade
 */
export declare function canTrade(): boolean;
/**
 * Check if there's an open position on a specific map
 */
export declare function hasOpenPositionOnMap(matchId: string, mapNumber: number): boolean;
/**
 * Calculate total open exposure
 */
export declare function getTotalOpenExposure(): number;
//# sourceMappingURL=state.d.ts.map