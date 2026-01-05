/**
 * Trade Decision Module
 * Evaluates whether to trade based on events and market conditions
 */
import { HLTVMatchState } from '../types/hltv';
import { PolymarketMarket } from '../types/polymarket';
import { TradeDecision } from '../types/state';
import { DetectedEvent } from './events';
/**
 * Evaluate if a trade should be made based on event
 */
export declare function evaluateTradeDecision(event: DetectedEvent, matchId: string, market: PolymarketMarket, hltvState: HLTVMatchState): Promise<TradeDecision>;
//# sourceMappingURL=decision.d.ts.map