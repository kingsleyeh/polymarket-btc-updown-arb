"use strict";
/**
 * Tournament Configuration
 * Defines which tournaments/events to monitor
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOURNAMENTS = void 0;
exports.getEnabledTournaments = getEnabledTournaments;
exports.findTournamentByHLTVId = findTournamentByHLTVId;
exports.findTournamentByPolymarketId = findTournamentByPolymarketId;
// Active tournament configurations
// These should be updated based on current events
exports.TOURNAMENTS = [
// Add tournament configurations here as needed
// Example:
// {
//   id: 'blast-premier-2024',
//   name: 'BLAST Premier World Final 2024',
//   polymarket_event_id: 'event-id-from-polymarket',
//   hltv_event_id: 'event-id-from-hltv',
//   enabled: true,
// },
];
/**
 * Get enabled tournaments
 */
function getEnabledTournaments() {
    return exports.TOURNAMENTS.filter((t) => t.enabled);
}
/**
 * Find tournament by HLTV event ID
 */
function findTournamentByHLTVId(hltvEventId) {
    return exports.TOURNAMENTS.find((t) => t.hltv_event_id === hltvEventId && t.enabled);
}
/**
 * Find tournament by Polymarket event ID
 */
function findTournamentByPolymarketId(polymarketEventId) {
    return exports.TOURNAMENTS.find((t) => t.polymarket_event_id === polymarketEventId && t.enabled);
}
//# sourceMappingURL=tournaments.js.map