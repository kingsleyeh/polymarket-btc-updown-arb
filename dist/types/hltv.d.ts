/**
 * HLTV Data Types
 * Live CS2 match state from HLTV
 */
export interface HLTVMatchState {
    match_id: string;
    is_live: boolean;
    is_paused: boolean;
    current_map_number: number;
    round_number: number;
    team_a_score: number;
    team_b_score: number;
    last_round_winner: 'team_a' | 'team_b' | null;
    last_update_timestamp: number;
}
export interface HLTVTeam {
    id: number;
    name: string;
}
export interface HLTVMatch {
    id: number;
    team1: HLTVTeam;
    team2: HLTVTeam;
    event: {
        id: number;
        name: string;
    };
    maps: HLTVMap[];
    status: string;
}
export interface HLTVMap {
    name: string;
    result?: {
        team1: number;
        team2: number;
    };
}
export interface HLTVScoreboardUpdate {
    round: number;
    ctScore: number;
    tScore: number;
    ctTeam: string;
    tTeam: string;
    bombPlanted: boolean;
    mapName: string;
}
export interface HLTVLogUpdate {
    round: number;
    event: string;
    winner?: {
        side: 'CT' | 'T';
        team: string;
    };
    player?: {
        name: string;
        team: string;
    };
}
//# sourceMappingURL=hltv.d.ts.map