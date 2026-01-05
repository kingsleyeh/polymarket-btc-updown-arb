"use strict";
/**
 * HLTV Match Discovery
 * Automatically finds live CS2 matches
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLiveMatches = getLiveMatches;
exports.getUpcomingMatches = getUpcomingMatches;
exports.prioritizeMatches = prioritizeMatches;
const hltv_1 = require("hltv");
const logger_1 = require("../logger/logger");
/**
 * Get all currently live CS2 matches from HLTV
 */
async function getLiveMatches() {
    try {
        const matches = await hltv_1.HLTV.getMatches();
        // Filter for live matches only
        const liveMatches = matches.filter((m) => m.live === true);
        const result = liveMatches.map((m) => ({
            id: m.id,
            team1: m.team1?.name || 'TBD',
            team2: m.team2?.name || 'TBD',
            event: m.event?.name || 'Unknown Event',
            maps: m.format?.type === 'bo3' ? 3 : m.format?.type === 'bo5' ? 5 : 1,
            stars: m.stars || 0,
        }));
        logger_1.logger.info(`Found ${result.length} live matches`, {
            matches: result.map(m => `${m.team1} vs ${m.team2}`),
        });
        return result;
    }
    catch (error) {
        logger_1.logger.error('Failed to fetch live matches', { error });
        return [];
    }
}
/**
 * Get upcoming matches (for pre-positioning)
 */
async function getUpcomingMatches() {
    try {
        const matches = await hltv_1.HLTV.getMatches();
        // Filter for upcoming matches (not live, has teams)
        const upcomingMatches = matches.filter((m) => !m.live && m.team1 && m.team2);
        const result = upcomingMatches.slice(0, 10).map((m) => ({
            id: m.id,
            team1: m.team1?.name || 'TBD',
            team2: m.team2?.name || 'TBD',
            event: m.event?.name || 'Unknown Event',
            maps: m.format?.type === 'bo3' ? 3 : m.format?.type === 'bo5' ? 5 : 1,
            stars: m.stars || 0,
        }));
        return result;
    }
    catch (error) {
        logger_1.logger.error('Failed to fetch upcoming matches', { error });
        return [];
    }
}
/**
 * Find high-priority matches (higher star rating = bigger matches)
 */
function prioritizeMatches(matches) {
    return [...matches].sort((a, b) => b.stars - a.stars);
}
//# sourceMappingURL=discovery.js.map