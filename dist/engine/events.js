"use strict";
/**
 * Event Detection Module
 * Detects tradeable events from HLTV state changes
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectEvents = detectEvents;
exports.clearEventContext = clearEventContext;
exports.resetAllEventContexts = resetAllEventContexts;
const parser_1 = require("../hltv/parser");
const constants_1 = require("../config/constants");
const logger_1 = require("../logger/logger");
// Store previous state for comparison
const eventContexts = new Map();
/**
 * Detect events from state change
 */
function detectEvents(matchId, currentState) {
    const events = [];
    // Get previous context or create new
    const prevContext = eventContexts.get(matchId) || {
        previousRound: 0,
        previousTeamAScore: 0,
        previousTeamBScore: 0,
    };
    // Skip if no state change
    if (currentState.round_number === prevContext.previousRound) {
        return events;
    }
    // Skip if match is paused
    if (currentState.is_paused) {
        return events;
    }
    // Skip if in overtime
    if ((0, parser_1.isOvertime)(currentState)) {
        return events;
    }
    // Detect pistol round win
    const pistolEvent = detectPistolRoundWin(currentState, prevContext);
    if (pistolEvent) {
        events.push(pistolEvent);
    }
    // Detect swing round
    const swingEvent = detectSwingRound(currentState, prevContext);
    if (swingEvent) {
        events.push(swingEvent);
    }
    // Detect map point
    const mapPointEvent = detectMapPoint(currentState, prevContext);
    if (mapPointEvent) {
        events.push(mapPointEvent);
    }
    // Update context
    eventContexts.set(matchId, {
        previousRound: currentState.round_number,
        previousTeamAScore: currentState.team_a_score,
        previousTeamBScore: currentState.team_b_score,
    });
    if (events.length > 0) {
        logger_1.logger.info('Events detected', {
            matchId,
            round: currentState.round_number,
            events: events.map((e) => e.type),
        });
    }
    return events;
}
/**
 * Detect pistol round win (round 1 or 16)
 */
function detectPistolRoundWin(state, prevContext) {
    // Check if this is right after a pistol round
    if (!constants_1.PISTOL_ROUNDS.includes(prevContext.previousRound)) {
        return null;
    }
    // Must be moving to round 2 or 17
    if (state.round_number !== prevContext.previousRound + 1) {
        return null;
    }
    // Pre-round score difference must be ≤ 1
    const preRoundScoreDiff = Math.abs(prevContext.previousTeamAScore - prevContext.previousTeamBScore);
    if (preRoundScoreDiff > 1) {
        return null;
    }
    // Must have a last round winner
    if (!state.last_round_winner) {
        return null;
    }
    logger_1.logger.debug('Pistol round win detected', {
        round: prevContext.previousRound,
        winner: state.last_round_winner,
    });
    return {
        type: 'pistol_round_win',
        team: state.last_round_winner,
        round_number: prevContext.previousRound,
        timestamp: Date.now(),
    };
}
/**
 * Detect swing round opportunity
 */
function detectSwingRound(state, prevContext) {
    // Not a pistol round
    if ((0, parser_1.isPistolRound)(prevContext.previousRound)) {
        return null;
    }
    // Score difference must be ≤ 2
    if ((0, parser_1.getScoreDifference)(state) > 2) {
        return null;
    }
    // Must have a last round winner
    if (!state.last_round_winner) {
        return null;
    }
    // Check if this is a swing (team that was behind or tied won)
    const wasTeamABehind = prevContext.previousTeamAScore <= prevContext.previousTeamBScore;
    const wasTeamBBehind = prevContext.previousTeamBScore <= prevContext.previousTeamAScore;
    const isSwing = (state.last_round_winner === 'team_a' && wasTeamABehind) ||
        (state.last_round_winner === 'team_b' && wasTeamBBehind);
    if (!isSwing) {
        return null;
    }
    logger_1.logger.debug('Swing round detected', {
        round: state.round_number,
        winner: state.last_round_winner,
        scoreDiff: (0, parser_1.getScoreDifference)(state),
    });
    return {
        type: 'swing_round',
        team: state.last_round_winner,
        round_number: state.round_number,
        timestamp: Date.now(),
    };
}
/**
 * Detect map point lag opportunity
 */
function detectMapPoint(state, prevContext) {
    // Check if a team just reached map point
    const teamAtMapPoint = (0, parser_1.isAtMapPoint)(state);
    if (!teamAtMapPoint) {
        return null;
    }
    // Check if they weren't at map point before
    const wasTeamAAtMapPoint = prevContext.previousTeamAScore === 12;
    const wasTeamBAtMapPoint = prevContext.previousTeamBScore === 12;
    if (teamAtMapPoint === 'team_a' && wasTeamAAtMapPoint) {
        return null;
    }
    if (teamAtMapPoint === 'team_b' && wasTeamBAtMapPoint) {
        return null;
    }
    logger_1.logger.debug('Map point detected', {
        team: teamAtMapPoint,
        round: state.round_number,
    });
    return {
        type: 'map_point_lag',
        team: teamAtMapPoint,
        round_number: state.round_number,
        timestamp: Date.now(),
    };
}
/**
 * Clear event context for a match
 */
function clearEventContext(matchId) {
    eventContexts.delete(matchId);
}
/**
 * Reset all event contexts
 */
function resetAllEventContexts() {
    eventContexts.clear();
}
//# sourceMappingURL=events.js.map