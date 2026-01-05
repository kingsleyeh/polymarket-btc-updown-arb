"use strict";
/**
 * HLTV Response Parser
 * Utility functions for HLTV match state
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getScoreDifference = getScoreDifference;
exports.isPistolRound = isPistolRound;
exports.isAtMapPoint = isAtMapPoint;
exports.isOvertime = isOvertime;
exports.getLeadingTeam = getLeadingTeam;
exports.isValidMatchState = isValidMatchState;
exports.isHalfTime = isHalfTime;
exports.getTotalRoundsPlayed = getTotalRoundsPlayed;
exports.hasTeamWonMap = hasTeamWonMap;
/**
 * Calculate score difference
 */
function getScoreDifference(state) {
    return Math.abs(state.team_a_score - state.team_b_score);
}
/**
 * Check if it's a pistol round (round 1 or 16)
 */
function isPistolRound(roundNumber) {
    return roundNumber === 1 || roundNumber === 16;
}
/**
 * Check if team is at map point (12 rounds)
 */
function isAtMapPoint(state) {
    const MAP_POINT_SCORE = 12;
    if (state.team_a_score === MAP_POINT_SCORE) {
        return 'team_a';
    }
    if (state.team_b_score === MAP_POINT_SCORE) {
        return 'team_b';
    }
    return null;
}
/**
 * Check if match is in overtime
 */
function isOvertime(state) {
    // Regulation ends at round 24 (if score is 12-12)
    // Overtime starts at round 25
    return state.round_number > 24;
}
/**
 * Get the leading team
 */
function getLeadingTeam(state) {
    if (state.team_a_score > state.team_b_score) {
        return 'team_a';
    }
    if (state.team_b_score > state.team_a_score) {
        return 'team_b';
    }
    return null;
}
/**
 * Validate that match state has all required fields
 */
function isValidMatchState(state) {
    return (typeof state.match_id === 'string' &&
        typeof state.is_live === 'boolean' &&
        typeof state.is_paused === 'boolean' &&
        typeof state.current_map_number === 'number' &&
        typeof state.round_number === 'number' &&
        typeof state.team_a_score === 'number' &&
        typeof state.team_b_score === 'number' &&
        typeof state.last_update_timestamp === 'number');
}
/**
 * Check if round is a half-switch round (round 13)
 */
function isHalfTime(roundNumber) {
    return roundNumber === 13;
}
/**
 * Get total rounds played
 */
function getTotalRoundsPlayed(state) {
    return state.team_a_score + state.team_b_score;
}
/**
 * Check if a team has won the map (13 rounds in regulation)
 */
function hasTeamWonMap(state) {
    const WIN_THRESHOLD = 13;
    if (state.team_a_score >= WIN_THRESHOLD && state.team_a_score > state.team_b_score) {
        return 'team_a';
    }
    if (state.team_b_score >= WIN_THRESHOLD && state.team_b_score > state.team_a_score) {
        return 'team_b';
    }
    return null;
}
//# sourceMappingURL=parser.js.map