/**
 * Types for BTC Up/Down Arbitrage
 */

/**
 * A BTC Up/Down 15-minute market
 */
export interface UpDownMarket {
  id: string;
  conditionId: string;
  question: string;
  
  // Token IDs for Up and Down outcomes
  up_token_id: string;
  down_token_id: string;
  
  // Expiry
  expiry_timestamp: number; // Unix timestamp
  
  // Metadata
  volume: number;
  created_at: string;
}

/**
 * Current prices for a market
 */
export interface MarketPrices {
  market_id: string;
  
  // Best ask prices (what you pay to buy)
  up_price: number;
  down_price: number;
  
  // Available shares at best ask
  up_shares_available: number;
  down_shares_available: number;
  
  timestamp: number;
}

/**
 * An arbitrage opportunity
 */
export interface ArbitrageOpportunity {
  id: string;
  market_id: string;
  market_title: string;
  
  // Token IDs for execution
  up_token_id: string;
  down_token_id: string;
  
  // Prices
  up_price: number;
  down_price: number;
  combined_cost: number;
  
  // Profit calculation
  edge: number; // 1.0 - combined_cost
  guaranteed_profit_per_share: number;
  
  // Executable size
  executable_shares: number;
  total_profit: number;
  
  // Liquidity
  up_shares_available: number;
  down_shares_available: number;
  
  // Timing
  expiry_timestamp: number;
  time_to_expiry_seconds: number;
  
  // Tracking
  first_detected_at: number;
  last_seen_at: number;
  consecutive_cycles: number;
}

/**
 * A simulated paper trade
 */
export interface PaperTrade {
  id: string;
  arb_id: string;
  market_id: string;
  market_title: string;
  
  // Entry
  up_price: number;
  down_price: number;
  combined_cost: number;
  shares: number;
  
  // Profit
  guaranteed_profit: number;
  
  // Timing
  entry_timestamp: number;
  expiry_timestamp: number;
  time_to_expiry_at_entry: number;
  
  // Status
  status: 'open' | 'settled';
  settlement_timestamp?: number;
}

/**
 * Logged arbitrage entry
 */
export interface ArbitrageLogEntry {
  timestamp: string;
  market_id: string;
  market_title: string;
  expiry_timestamp: number;
  up_price: number;
  down_price: number;
  combined_cost: number;
  simulated_shares: number;
  guaranteed_profit: number;
  up_liquidity: number;
  down_liquidity: number;
  time_to_expiry_at_entry: number;
  persistence_duration_sec: number;
  scan_cycles_observed: number;
  disappearance_reason?: 'price_moved' | 'liquidity_exhausted' | 'expiry_cutoff' | 'still_active';
}

/**
 * Scan statistics
 */
export interface ScanStats {
  total_scans: number;
  markets_scanned: number;
  arbs_found: number;
  arbs_per_hour: number;
  start_time: number;
}
