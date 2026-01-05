"use strict";
/**
 * Bot State Management
 * Centralized state for the trading bot
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeState = initializeState;
exports.getState = getState;
exports.updateBalance = updateBalance;
exports.setRunning = setRunning;
exports.haltBot = haltBot;
exports.resumeBot = resumeBot;
exports.setCooldown = setCooldown;
exports.isInCooldown = isInCooldown;
exports.incrementLosses = incrementLosses;
exports.resetLosses = resetLosses;
exports.getConsecutiveLosses = getConsecutiveLosses;
exports.addActiveTrade = addActiveTrade;
exports.removeActiveTrade = removeActiveTrade;
exports.getActiveTrade = getActiveTrade;
exports.getActiveTrades = getActiveTrades;
exports.getActiveTradesForMap = getActiveTradesForMap;
exports.updateActiveTrade = updateActiveTrade;
exports.setMatchContext = setMatchContext;
exports.getMatchContext = getMatchContext;
exports.removeMatchContext = removeMatchContext;
exports.updateHLTVTimestamp = updateHLTVTimestamp;
exports.updatePolymarketTimestamp = updatePolymarketTimestamp;
exports.canTrade = canTrade;
exports.hasOpenPositionOnMap = hasOpenPositionOnMap;
exports.getTotalOpenExposure = getTotalOpenExposure;
const logger_1 = require("../logger/logger");
// Global bot state
let botState = {
    is_running: false,
    is_halted: false,
    halt_reason: undefined,
    halt_timestamp: undefined,
    cooldown_until: undefined,
    peak_balance: 0,
    current_balance: 0,
    consecutive_losses: 0,
    active_trades: [],
    match_contexts: new Map(),
    last_hltv_update: 0,
    last_polymarket_update: 0,
};
/**
 * Initialize bot state
 */
function initializeState(initialBalance) {
    botState = {
        is_running: true,
        is_halted: false,
        halt_reason: undefined,
        halt_timestamp: undefined,
        cooldown_until: undefined,
        peak_balance: initialBalance,
        current_balance: initialBalance,
        consecutive_losses: 0,
        active_trades: [],
        match_contexts: new Map(),
        last_hltv_update: 0,
        last_polymarket_update: 0,
    };
    logger_1.logger.info('Bot state initialized', { initialBalance });
}
/**
 * Get current bot state
 */
function getState() {
    return botState;
}
/**
 * Update balance and track peak
 */
function updateBalance(newBalance) {
    botState.current_balance = newBalance;
    if (newBalance > botState.peak_balance) {
        botState.peak_balance = newBalance;
        logger_1.logger.info('New peak balance', { peak: newBalance });
    }
}
/**
 * Set bot running state
 */
function setRunning(running) {
    botState.is_running = running;
}
/**
 * Halt the bot
 */
function haltBot(reason) {
    botState.is_halted = true;
    botState.halt_reason = reason;
    botState.halt_timestamp = Date.now();
    logger_1.logger.warn('Bot halted', { reason });
}
/**
 * Resume bot after cooldown
 */
function resumeBot() {
    botState.is_halted = false;
    botState.halt_reason = undefined;
    botState.halt_timestamp = undefined;
    botState.cooldown_until = undefined;
    logger_1.logger.info('Bot resumed');
}
/**
 * Set cooldown period
 */
function setCooldown(durationMs) {
    botState.cooldown_until = Date.now() + durationMs;
    logger_1.logger.info('Cooldown set', { until: new Date(botState.cooldown_until).toISOString() });
}
/**
 * Check if in cooldown period
 */
function isInCooldown() {
    if (!botState.cooldown_until) {
        return false;
    }
    return Date.now() < botState.cooldown_until;
}
/**
 * Increment consecutive losses
 */
function incrementLosses() {
    botState.consecutive_losses++;
    logger_1.logger.warn('Consecutive loss', { count: botState.consecutive_losses });
}
/**
 * Reset consecutive losses
 */
function resetLosses() {
    botState.consecutive_losses = 0;
}
/**
 * Get consecutive losses count
 */
function getConsecutiveLosses() {
    return botState.consecutive_losses;
}
/**
 * Add active trade
 */
function addActiveTrade(trade) {
    botState.active_trades.push(trade);
    logger_1.logger.info('Active trade added', {
        id: trade.id,
        matchId: trade.match_id,
        mapNumber: trade.map_number,
        trigger: trade.trigger_type,
    });
}
/**
 * Remove active trade
 */
function removeActiveTrade(tradeId) {
    botState.active_trades = botState.active_trades.filter((t) => t.id !== tradeId);
}
/**
 * Get active trade by ID
 */
function getActiveTrade(tradeId) {
    return botState.active_trades.find((t) => t.id === tradeId);
}
/**
 * Get all active trades
 */
function getActiveTrades() {
    return [...botState.active_trades];
}
/**
 * Get active trades for a specific match/map
 */
function getActiveTradesForMap(matchId, mapNumber) {
    return botState.active_trades.filter((t) => t.match_id === matchId && t.map_number === mapNumber && t.status === 'open');
}
/**
 * Update active trade
 */
function updateActiveTrade(tradeId, updates) {
    const index = botState.active_trades.findIndex((t) => t.id === tradeId);
    if (index !== -1) {
        botState.active_trades[index] = { ...botState.active_trades[index], ...updates };
    }
}
/**
 * Set or update match context
 */
function setMatchContext(matchId, context) {
    botState.match_contexts.set(matchId, context);
}
/**
 * Get match context
 */
function getMatchContext(matchId) {
    return botState.match_contexts.get(matchId);
}
/**
 * Remove match context
 */
function removeMatchContext(matchId) {
    botState.match_contexts.delete(matchId);
}
/**
 * Update HLTV timestamp
 */
function updateHLTVTimestamp(timestamp) {
    botState.last_hltv_update = timestamp;
}
/**
 * Update Polymarket timestamp
 */
function updatePolymarketTimestamp(timestamp) {
    botState.last_polymarket_update = timestamp;
}
/**
 * Check if bot can trade
 */
function canTrade() {
    return botState.is_running && !botState.is_halted && !isInCooldown();
}
/**
 * Check if there's an open position on a specific map
 */
function hasOpenPositionOnMap(matchId, mapNumber) {
    return botState.active_trades.some((t) => t.match_id === matchId && t.map_number === mapNumber && t.status === 'open');
}
/**
 * Calculate total open exposure
 */
function getTotalOpenExposure() {
    return botState.active_trades
        .filter((t) => t.status === 'open')
        .reduce((sum, t) => sum + t.entry_size, 0);
}
//# sourceMappingURL=state.js.map