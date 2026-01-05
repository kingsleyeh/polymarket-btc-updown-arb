/**
 * Bot State Types
 * Internal state management types
 */
import { HLTVMatchState } from './hltv';
import { PolymarketMarket } from './polymarket';
export type TriggerType = 'pistol_round_win' | 'swing_round' | 'map_point_lag';
export interface ActiveTrade {
    id: string;
    match_id: string;
    map_number: number;
    market_id: string;
    token_id: string;
    team: 'team_a' | 'team_b';
    trigger_type: TriggerType;
    entry_price: number;
    entry_size: number;
    entry_timestamp: number;
    entry_round: number;
    exit_price?: number;
    exit_timestamp?: number;
    pnl?: number;
    status: 'open' | 'closed' | 'exited';
}
export interface MapState {
    map_number: number;
    market_id: string;
    has_open_position: boolean;
    active_trade?: ActiveTrade;
}
export interface MatchContext {
    match_id: string;
    hltv_state: HLTVMatchState;
    market: PolymarketMarket | null;
    map_states: Map<number, MapState>;
    last_processed_round: number;
}
export interface BotState {
    is_running: boolean;
    is_halted: boolean;
    halt_reason?: string;
    halt_timestamp?: number;
    cooldown_until?: number;
    peak_balance: number;
    current_balance: number;
    consecutive_losses: number;
    active_trades: ActiveTrade[];
    match_contexts: Map<string, MatchContext>;
    last_hltv_update: number;
    last_polymarket_update: number;
}
export interface TradeDecision {
    should_trade: boolean;
    trigger_type?: TriggerType;
    team?: 'team_a' | 'team_b';
    token_id?: string;
    price?: number;
    size?: number;
    size_multiplier?: number;
    reason?: string;
}
export interface ExitDecision {
    should_exit: boolean;
    reason?: ExitReason;
    current_price?: number;
}
export type ExitReason = 'profit_target' | 'next_round_no_reprice' | 'feed_stale' | 'market_suspended' | 'overtime' | 'manual';
export interface TradeLog {
    timestamp: number;
    match_id: string;
    map_number: number;
    trigger_type: TriggerType;
    entry_price: number;
    exit_price: number;
    trade_size: number;
    pnl: number;
    event_to_execution_latency_ms: number;
}
export interface RiskState {
    total_exposure: number;
    exposure_percent: number;
    drawdown_percent: number;
    can_trade: boolean;
    reason?: string;
}
//# sourceMappingURL=state.d.ts.map