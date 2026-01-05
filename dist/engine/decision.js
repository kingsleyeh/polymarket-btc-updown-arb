"use strict";
/**
 * Trade Decision Module
 * Evaluates whether to trade based on events and market conditions
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateTradeDecision = evaluateTradeDecision;
const constants_1 = require("../config/constants");
const markets_1 = require("../polymarket/markets");
const balance_1 = require("../polymarket/balance");
const exposure_1 = require("../risk/exposure");
const state_1 = require("./state");
const client_1 = require("../hltv/client");
const logger_1 = require("../logger/logger");
/**
 * Evaluate if a trade should be made based on event
 */
async function evaluateTradeDecision(event, matchId, market, hltvState) {
    // Default to no trade
    const noTrade = { should_trade: false };
    // Check if bot can trade
    if (!(0, state_1.canTrade)()) {
        logger_1.logger.debug('Bot cannot trade currently');
        return { ...noTrade, reason: 'Bot halted or in cooldown' };
    }
    // Check entry preconditions
    const preconditionResult = await checkEntryPreconditions(matchId, market, hltvState);
    if (!preconditionResult.passed) {
        return { ...noTrade, reason: preconditionResult.reason };
    }
    // Get token ID for the winning team
    const tokenId = event.team === 'team_a' ? market.team_a_token_id : market.team_b_token_id;
    // Fetch current price
    let price;
    try {
        price = await (0, markets_1.fetchPrice)(tokenId);
    }
    catch (error) {
        logger_1.logger.error('Failed to fetch price for decision', { error, tokenId });
        return { ...noTrade, reason: 'Failed to fetch price' };
    }
    // Evaluate based on trigger type
    const decision = await evaluateTrigger(event.type, price.yes_price, matchId, market, tokenId);
    if (decision.should_trade) {
        logger_1.logger.info('Trade decision: BUY', {
            trigger: event.type,
            team: event.team,
            price: price.yes_price,
            size: decision.size,
        });
    }
    return decision;
}
/**
 * Check all entry preconditions
 */
async function checkEntryPreconditions(matchId, market, hltvState) {
    // 1. HLTV feed fresh
    const hltvClient = (0, client_1.getHLTVClient)();
    if (!hltvClient.isFeedFresh()) {
        return { passed: false, reason: 'HLTV feed stale' };
    }
    // 2. Market open
    if (market.status !== 'open') {
        return { passed: false, reason: 'Market not open' };
    }
    // 3. Liquidity threshold
    if (market.liquidity < constants_1.MIN_LIQUIDITY) {
        return { passed: false, reason: 'Insufficient liquidity' };
    }
    // 4. No existing position on this map
    if ((0, state_1.hasOpenPositionOnMap)(matchId, hltvState.current_map_number)) {
        return { passed: false, reason: 'Existing position on map' };
    }
    // 5. Exposure constraint
    const exposureCheck = await (0, exposure_1.checkExposure)();
    if (!exposureCheck.can_trade) {
        return { passed: false, reason: exposureCheck.reason };
    }
    // 6. Match not paused
    if (hltvState.is_paused) {
        return { passed: false, reason: 'Match paused' };
    }
    return { passed: true };
}
/**
 * Evaluate specific trigger type
 */
async function evaluateTrigger(triggerType, currentPrice, matchId, market, tokenId) {
    const noTrade = { should_trade: false };
    switch (triggerType) {
        case 'pistol_round_win':
            return evaluatePistolRoundTrigger(currentPrice, market, tokenId);
        case 'swing_round':
            return evaluateSwingRoundTrigger(currentPrice, market, tokenId);
        case 'map_point_lag':
            return evaluateMapPointTrigger(currentPrice, market, tokenId);
        default:
            return noTrade;
    }
}
/**
 * Evaluate Trigger A: Pistol Round Win
 */
async function evaluatePistolRoundTrigger(price, market, tokenId) {
    // Price must be < 0.55
    if (price >= constants_1.PISTOL_ROUND_MAX_PRICE) {
        return {
            should_trade: false,
            reason: `Price ${price} >= ${constants_1.PISTOL_ROUND_MAX_PRICE}`,
        };
    }
    // Calculate trade size
    const balance = await (0, balance_1.fetchBalance)();
    const size = balance.available_balance * constants_1.POSITION_SIZE_PERCENT;
    return {
        should_trade: true,
        trigger_type: 'pistol_round_win',
        token_id: tokenId,
        price,
        size,
        size_multiplier: 1.0,
    };
}
/**
 * Evaluate Trigger B: Swing Round
 */
async function evaluateSwingRoundTrigger(price, market, tokenId) {
    // Price must be < 0.60
    if (price >= constants_1.SWING_ROUND_MAX_PRICE) {
        return {
            should_trade: false,
            reason: `Price ${price} >= ${constants_1.SWING_ROUND_MAX_PRICE}`,
        };
    }
    // Calculate trade size (50% of normal)
    const balance = await (0, balance_1.fetchBalance)();
    const fullSize = balance.available_balance * constants_1.POSITION_SIZE_PERCENT;
    const size = fullSize * constants_1.SWING_ROUND_SIZE_MULTIPLIER;
    return {
        should_trade: true,
        trigger_type: 'swing_round',
        token_id: tokenId,
        price,
        size,
        size_multiplier: constants_1.SWING_ROUND_SIZE_MULTIPLIER,
    };
}
/**
 * Evaluate Trigger C: Map Point Lag
 */
async function evaluateMapPointTrigger(price, market, tokenId) {
    // Price must be < 0.70
    if (price >= constants_1.MAP_POINT_MAX_PRICE) {
        return {
            should_trade: false,
            reason: `Price ${price} >= ${constants_1.MAP_POINT_MAX_PRICE}`,
        };
    }
    // Calculate trade size
    const balance = await (0, balance_1.fetchBalance)();
    const size = balance.available_balance * constants_1.POSITION_SIZE_PERCENT;
    return {
        should_trade: true,
        trigger_type: 'map_point_lag',
        token_id: tokenId,
        price,
        size,
        size_multiplier: 1.0,
    };
}
//# sourceMappingURL=decision.js.map