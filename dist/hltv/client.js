"use strict";
/**
 * HLTV Client
 * Handles live match data from HLTV using the hltv npm package
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HLTVClient = void 0;
exports.getHLTVClient = getHLTVClient;
const hltv_1 = require("hltv");
const constants_1 = require("../config/constants");
const logger_1 = require("../logger/logger");
class HLTVClient {
    currentMatchState = null;
    isConnected = false;
    matchInfo = null;
    currentMapNumber = 1;
    team1IsCT = true; // Track which side team1 is on
    disconnectFn = null;
    constructor() { }
    /**
     * Start listening to live match data via scorebot
     */
    async startPolling(matchId) {
        if (this.isConnected) {
            logger_1.logger.warn('HLTV scorebot already connected');
            return;
        }
        const numericMatchId = parseInt(matchId, 10);
        if (isNaN(numericMatchId)) {
            logger_1.logger.error('Invalid match ID', { matchId });
            return;
        }
        logger_1.logger.info(`Connecting to HLTV scorebot for match ${matchId}`);
        try {
            // Fetch match info first
            const matchData = await hltv_1.HLTV.getMatch({ id: numericMatchId });
            this.matchInfo = matchData;
            logger_1.logger.info('Match info fetched', {
                matchId: numericMatchId,
                team1: this.matchInfo.team1?.name,
                team2: this.matchInfo.team2?.name,
            });
            // Connect to scorebot
            hltv_1.HLTV.connectToScorebot({
                id: numericMatchId,
                onScoreboardUpdate: (data, done) => {
                    this.handleScorebotUpdate(matchId, data);
                    done();
                },
                onLogUpdate: (data, done) => {
                    this.handleLogUpdate(matchId, data);
                    done();
                },
                onConnect: () => {
                    this.isConnected = true;
                    logger_1.logger.info('Connected to HLTV scorebot');
                },
                onDisconnect: () => {
                    this.isConnected = false;
                    logger_1.logger.warn('Disconnected from HLTV scorebot');
                },
            });
        }
        catch (error) {
            logger_1.logger.error('Failed to connect to HLTV scorebot', { error, matchId });
        }
    }
    /**
     * Handle scorebot scoreboard updates
     */
    handleScorebotUpdate(matchId, data) {
        const timestamp = Date.now();
        // Determine which team is CT based on team IDs
        if (this.matchInfo) {
            this.team1IsCT = data.ctTeamId === this.matchInfo.team1.id;
        }
        // Map scores to team_a (team1) and team_b (team2)
        let team_a_score;
        let team_b_score;
        if (this.team1IsCT) {
            team_a_score = data.counterTerroristScore;
            team_b_score = data.terroristScore;
        }
        else {
            team_a_score = data.terroristScore;
            team_b_score = data.counterTerroristScore;
        }
        this.currentMatchState = {
            match_id: matchId,
            is_live: data.live,
            is_paused: data.frozen,
            current_map_number: this.currentMapNumber,
            round_number: data.currentRound,
            team_a_score,
            team_b_score,
            last_round_winner: this.currentMatchState?.last_round_winner ?? null,
            last_update_timestamp: timestamp,
        };
        logger_1.logger.debug('Scorebot update', {
            round: data.currentRound,
            score: `${team_a_score}-${team_b_score}`,
            live: data.live,
            frozen: data.frozen,
        });
    }
    /**
     * Handle scorebot log updates (round events)
     */
    handleLogUpdate(matchId, data) {
        if (!this.currentMatchState) {
            return;
        }
        this.currentMatchState.last_update_timestamp = Date.now();
        // Look for RoundEnd events in the log
        for (const event of data.log) {
            if ('RoundEnd' in event) {
                const roundEnd = event.RoundEnd;
                // Determine winner based on side
                const winnerSide = roundEnd.winner;
                if (winnerSide === 'CT') {
                    this.currentMatchState.last_round_winner = this.team1IsCT ? 'team_a' : 'team_b';
                }
                else if (winnerSide === 'TERRORIST') {
                    this.currentMatchState.last_round_winner = this.team1IsCT ? 'team_b' : 'team_a';
                }
                logger_1.logger.debug('Round ended', {
                    winner: this.currentMatchState.last_round_winner,
                    ctScore: roundEnd.counterTerroristScore,
                    tScore: roundEnd.terroristScore,
                });
            }
        }
    }
    /**
     * Stop listening to scorebot
     */
    stopPolling() {
        if (this.disconnectFn) {
            this.disconnectFn();
            this.disconnectFn = null;
        }
        this.isConnected = false;
        logger_1.logger.info('HLTV scorebot disconnected');
    }
    /**
     * Fetch match info (for initial setup)
     */
    async fetchMatchState(matchId) {
        return this.currentMatchState;
    }
    /**
     * Get current match state
     */
    getMatchState() {
        return this.currentMatchState;
    }
    /**
     * Check if feed is fresh (within FEED_STALE_MS)
     */
    isFeedFresh() {
        if (!this.currentMatchState) {
            return false;
        }
        const now = Date.now();
        const staleness = now - this.currentMatchState.last_update_timestamp;
        return staleness <= constants_1.FEED_STALE_MS;
    }
    /**
     * Get feed staleness in milliseconds
     */
    getFeedStaleness() {
        if (!this.currentMatchState) {
            return Infinity;
        }
        return Date.now() - this.currentMatchState.last_update_timestamp;
    }
    /**
     * Check if match is live and not paused
     */
    isMatchActive() {
        if (!this.currentMatchState) {
            return false;
        }
        return this.currentMatchState.is_live && !this.currentMatchState.is_paused;
    }
    /**
     * Check if connected to scorebot
     */
    isConnectedToScorebot() {
        return this.isConnected;
    }
    /**
     * Get last update timestamp
     */
    getLastUpdateTimestamp() {
        return this.currentMatchState?.last_update_timestamp ?? 0;
    }
    /**
     * Set current map number (called when map changes)
     */
    setCurrentMapNumber(mapNumber) {
        this.currentMapNumber = mapNumber;
        if (this.currentMatchState) {
            this.currentMatchState.current_map_number = mapNumber;
        }
    }
    /**
     * Get match info
     */
    getMatchInfo() {
        return this.matchInfo;
    }
    /**
     * Get team names
     */
    getTeamNames() {
        if (!this.matchInfo) {
            return null;
        }
        return {
            team_a: this.matchInfo.team1.name,
            team_b: this.matchInfo.team2.name,
        };
    }
}
exports.HLTVClient = HLTVClient;
// Singleton instance
let hltvClientInstance = null;
function getHLTVClient() {
    if (!hltvClientInstance) {
        hltvClientInstance = new HLTVClient();
    }
    return hltvClientInstance;
}
//# sourceMappingURL=client.js.map