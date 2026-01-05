"use strict";
/**
 * Kill Switch Module
 * Handles emergency halts and trading suspensions
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkKillSwitch = checkKillSwitch;
exports.triggerKillSwitch = triggerKillSwitch;
exports.manualKillSwitch = manualKillSwitch;
exports.runKillSwitchCheck = runKillSwitchCheck;
const client_1 = require("../hltv/client");
const client_2 = require("../polymarket/client");
const drawdown_1 = require("./drawdown");
const state_1 = require("../engine/state");
const constants_1 = require("../config/constants");
const logger_1 = require("../logger/logger");
/**
 * Check all kill switch conditions
 */
async function checkKillSwitch() {
    // 1. Check HLTV feed staleness
    const hltvCheck = checkHLTVFeed();
    if (hltvCheck.triggered) {
        return hltvCheck;
    }
    // 2. Check Polymarket API errors
    const polymarketCheck = checkPolymarketAPI();
    if (polymarketCheck.triggered) {
        return polymarketCheck;
    }
    // 3. Check consecutive losses
    const lossesCheck = checkConsecutiveLosses();
    if (lossesCheck.triggered) {
        return lossesCheck;
    }
    // 4. Check drawdown
    const drawdownCheck = await checkMaxDrawdown();
    if (drawdownCheck.triggered) {
        return drawdownCheck;
    }
    return { triggered: false };
}
/**
 * Check HLTV feed staleness
 * Only triggers if we have an active connection that went stale
 */
function checkHLTVFeed() {
    const hltvClient = (0, client_1.getHLTVClient)();
    // Don't trigger if there's no match state (no active session)
    const matchState = hltvClient.getMatchState();
    if (!matchState) {
        // No active match being tracked - this is fine
        return { triggered: false };
    }
    if (!hltvClient.isFeedFresh()) {
        const staleness = hltvClient.getFeedStaleness();
        return {
            triggered: true,
            reason: 'hltv_feed_stale',
            details: `HLTV feed stale for ${staleness}ms`,
        };
    }
    return { triggered: false };
}
/**
 * Check Polymarket API error spike
 */
function checkPolymarketAPI() {
    const polymarketClient = (0, client_2.getPolymarketClient)();
    if (polymarketClient.isExperiencingErrors()) {
        const errorCount = polymarketClient.getErrorCount();
        return {
            triggered: true,
            reason: 'polymarket_api_errors',
            details: `Polymarket API errors spiked: ${errorCount} errors`,
        };
    }
    return { triggered: false };
}
/**
 * Check consecutive losses
 */
function checkConsecutiveLosses() {
    const consecutiveLosses = (0, state_1.getConsecutiveLosses)();
    if (consecutiveLosses >= constants_1.MAX_CONSECUTIVE_LOSSES) {
        return {
            triggered: true,
            reason: 'consecutive_losses',
            details: `${consecutiveLosses} consecutive losing trades`,
        };
    }
    return { triggered: false };
}
/**
 * Check max drawdown
 */
async function checkMaxDrawdown() {
    const drawdownStatus = await (0, drawdown_1.isDrawdownExceeded)();
    if (drawdownStatus.exceeded) {
        return {
            triggered: true,
            reason: 'max_drawdown',
            details: `Drawdown ${(drawdownStatus.drawdown_percent * 100).toFixed(2)}% exceeds max ${(drawdownStatus.max_percent * 100).toFixed(2)}%`,
        };
    }
    return { triggered: false };
}
/**
 * Trigger kill switch and halt bot
 */
function triggerKillSwitch(reason, details) {
    const message = details || getReasonMessage(reason);
    logger_1.logger.error('KILL SWITCH TRIGGERED', {
        reason,
        details: message,
    });
    // Halt the bot
    (0, state_1.haltBot)(message);
    // Set cooldown
    (0, state_1.setCooldown)(constants_1.COOLDOWN_MS);
    logger_1.logger.warn('Bot halted with cooldown', {
        cooldownMinutes: constants_1.COOLDOWN_MS / 60000,
    });
}
/**
 * Get human-readable message for kill switch reason
 */
function getReasonMessage(reason) {
    switch (reason) {
        case 'hltv_feed_stale':
            return 'HLTV live feed became stale';
        case 'polymarket_api_errors':
            return 'Polymarket API experiencing errors';
        case 'consecutive_losses':
            return `${constants_1.MAX_CONSECUTIVE_LOSSES} consecutive losing trades`;
        case 'max_drawdown':
            return 'Maximum drawdown threshold exceeded';
        case 'manual':
            return 'Manual kill switch activation';
        default:
            return 'Unknown kill switch reason';
    }
}
/**
 * Manual kill switch trigger
 */
function manualKillSwitch(reason) {
    triggerKillSwitch('manual', reason || 'Manual activation');
}
/**
 * Run kill switch check and trigger if needed
 */
async function runKillSwitchCheck() {
    const state = (0, state_1.getState)();
    // Skip if already halted
    if (state.is_halted) {
        return false;
    }
    const check = await checkKillSwitch();
    if (check.triggered && check.reason) {
        triggerKillSwitch(check.reason, check.details);
        return true;
    }
    return false;
}
//# sourceMappingURL=killswitch.js.map