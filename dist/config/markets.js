"use strict";
/**
 * Market Configuration
 * Market type definitions and validation
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MARKET_TYPE_MAP_WINNER = void 0;
exports.isValidMapWinnerMarket = isValidMapWinnerMarket;
exports.filterMapWinnerMarkets = filterMapWinnerMarkets;
exports.extractMapNumberFromQuestion = extractMapNumberFromQuestion;
exports.matchTeamToToken = matchTeamToToken;
const constants_1 = require("./constants");
exports.MARKET_TYPE_MAP_WINNER = 'Map Winner';
/**
 * Check if a market is a valid Map Winner market for trading
 */
function isValidMapWinnerMarket(market, currentMapNumber) {
    return (market.type === exports.MARKET_TYPE_MAP_WINNER &&
        market.status === 'open' &&
        market.mapNumber === currentMapNumber &&
        market.liquidity >= constants_1.MIN_LIQUIDITY);
}
/**
 * Filter markets to get valid Map Winner markets for current map
 */
function filterMapWinnerMarkets(markets, currentMapNumber) {
    return markets.filter((m) => isValidMapWinnerMarket(m, currentMapNumber));
}
/**
 * Extract map number from market question if available
 * Expected format: "Who will win Map X?"
 */
function extractMapNumberFromQuestion(question) {
    const match = question.match(/Map\s*(\d+)/i);
    if (match && match[1]) {
        return parseInt(match[1], 10);
    }
    return null;
}
/**
 * Match HLTV team names to Polymarket market teams
 * Returns the token ID for the matched team
 */
function matchTeamToToken(market, teamName) {
    const normalizedTeamName = teamName.toLowerCase().trim();
    const normalizedTeamA = market.team_a_name.toLowerCase().trim();
    const normalizedTeamB = market.team_b_name.toLowerCase().trim();
    if (normalizedTeamA.includes(normalizedTeamName) || normalizedTeamName.includes(normalizedTeamA)) {
        return market.team_a_token_id;
    }
    if (normalizedTeamB.includes(normalizedTeamName) || normalizedTeamName.includes(normalizedTeamB)) {
        return market.team_b_token_id;
    }
    return null;
}
//# sourceMappingURL=markets.js.map