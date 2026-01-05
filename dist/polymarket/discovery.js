"use strict";
/**
 * Polymarket Market Discovery
 * Automatically finds CS2 markets on Polymarket using Gamma API
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findCS2Events = findCS2Events;
exports.findMarketForMatch = findMarketForMatch;
exports.getAllActiveMapWinnerMarkets = getAllActiveMapWinnerMarkets;
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("../logger/logger");
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';
/**
 * Search Polymarket for CS2/Counter-Strike events
 */
async function findCS2Events() {
    const allEvents = [];
    try {
        // Search for esports/gaming events
        const response = await axios_1.default.get(`${GAMMA_API_URL}/events`, {
            params: {
                active: true,
                closed: false,
                limit: 100,
            },
            timeout: 10000,
        });
        const events = response.data || [];
        // Filter for CS2/Counter-Strike related events
        const cs2Keywords = ['cs2', 'counter-strike', 'csgo', 'cs:go', 'counter strike', 'blast', 'esl', 'iem', 'major'];
        for (const event of events) {
            const titleLower = (event.title || '').toLowerCase();
            const descLower = (event.description || '').toLowerCase();
            const isCS2 = cs2Keywords.some(keyword => titleLower.includes(keyword) || descLower.includes(keyword));
            if (isCS2) {
                allEvents.push(event);
            }
        }
        logger_1.logger.info(`Found ${allEvents.length} CS2 events on Polymarket`);
        return allEvents;
    }
    catch (error) {
        logger_1.logger.error('Failed to search Polymarket events', { error });
        return [];
    }
}
/**
 * Match HLTV match to Polymarket market
 * Uses team names to find corresponding market
 */
async function findMarketForMatch(team1, team2) {
    try {
        const events = await findCS2Events();
        // Normalize team names for matching
        const normalizeTeam = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
        const t1 = normalizeTeam(team1);
        const t2 = normalizeTeam(team2);
        for (const event of events) {
            const eventTitle = normalizeTeam(event.title);
            // Check if event contains team names
            const matchesT1 = eventTitle.includes(t1) || t1.includes(eventTitle.slice(0, 4));
            const matchesT2 = eventTitle.includes(t2) || t2.includes(eventTitle.slice(0, 4));
            // Also check raw title
            const titleLower = event.title.toLowerCase();
            const hasTeam1 = titleLower.includes(team1.toLowerCase());
            const hasTeam2 = titleLower.includes(team2.toLowerCase());
            if ((matchesT1 || matchesT2) || (hasTeam1 || hasTeam2)) {
                // Look for Map Winner markets
                for (const market of event.markets || []) {
                    const question = (market.question || '').toLowerCase();
                    if (question.includes('map') &&
                        (question.includes('winner') || question.includes('win'))) {
                        if (market.clobTokenIds?.length >= 2 && market.outcomes?.length >= 2) {
                            logger_1.logger.info('Found matching market', {
                                eventId: event.id,
                                marketId: market.id,
                                question: market.question,
                            });
                            return {
                                eventId: event.id,
                                market: {
                                    id: market.id,
                                    condition_id: market.conditionId,
                                    question: market.question,
                                    type: 'Map Winner',
                                    status: market.active && !market.closed ? 'open' : 'closed',
                                    team_a_token_id: market.clobTokenIds[0],
                                    team_b_token_id: market.clobTokenIds[1],
                                    team_a_name: market.outcomes[0],
                                    team_b_name: market.outcomes[1],
                                    liquidity: parseFloat(market.liquidity || '0'),
                                    volume: 0,
                                },
                            };
                        }
                    }
                }
            }
        }
        logger_1.logger.debug('No matching market found', { team1, team2 });
        return null;
    }
    catch (error) {
        logger_1.logger.error('Failed to find market for match', { error, team1, team2 });
        return null;
    }
}
/**
 * Get all active CS2 Map Winner markets
 */
async function getAllActiveMapWinnerMarkets() {
    try {
        const events = await findCS2Events();
        const results = [];
        for (const event of events) {
            if (!event.active || event.closed)
                continue;
            for (const market of event.markets || []) {
                if (!market.active || market.closed)
                    continue;
                const question = (market.question || '').toLowerCase();
                if (question.includes('map') &&
                    (question.includes('winner') || question.includes('win'))) {
                    if (market.clobTokenIds?.length >= 2 && market.outcomes?.length >= 2) {
                        results.push({
                            eventId: event.id,
                            market: {
                                id: market.id,
                                condition_id: market.conditionId,
                                question: market.question,
                                type: 'Map Winner',
                                status: 'open',
                                team_a_token_id: market.clobTokenIds[0],
                                team_b_token_id: market.clobTokenIds[1],
                                team_a_name: market.outcomes[0],
                                team_b_name: market.outcomes[1],
                                liquidity: parseFloat(market.liquidity || '0'),
                                volume: 0,
                            },
                            teams: market.outcomes,
                        });
                    }
                }
            }
        }
        logger_1.logger.info(`Found ${results.length} active Map Winner markets`);
        return results;
    }
    catch (error) {
        logger_1.logger.error('Failed to get active markets', { error });
        return [];
    }
}
//# sourceMappingURL=discovery.js.map