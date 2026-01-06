/**
 * FAST MARKET ORDER Execution
 * 
 * TRUE market orders: buy at $0.99 to take ANY available ask
 * Minimal waits - speed is everything
 */

import { ClobClient, Side, AssetType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import { ArbitrageOpportunity } from '../types/arbitrage';

const MIN_SHARES = 5;
const SETTLEMENT_WAIT_MS = 1500; // Only needed for sells (token settlement)

const CHAIN_ID = 137;
const CLOB_HOST = 'https://clob.polymarket.com';

let clobClient: ClobClient | null = null;
let wallet: ethers.Wallet | null = null;
let cachedBalance: number = 0;

const brokenMarkets: Set<string> = new Set();
const completedMarkets: Set<string> = new Set();

interface ExecutedTrade {
  id: string;
  market_id: string;
  shares: number;
  status: 'filled' | 'failed';
  has_exposure: boolean;
  can_retry: boolean;
  error?: string;
}

const executedTrades: ExecutedTrade[] = [];

export function canTradeMarket(marketId: string): boolean {
  return !brokenMarkets.has(marketId) && !completedMarkets.has(marketId);
}

export async function initializeTrader(): Promise<boolean> {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) {
    console.error('ERROR: POLYMARKET_PRIVATE_KEY not set');
    return false;
  }

  const funder = process.env.POLYMARKET_PROXY_WALLET || '';
  const signatureType = parseInt(process.env.POLYMARKET_SIGNATURE_TYPE || '0', 10);

  try {
    wallet = new ethers.Wallet(privateKey);
    console.log(`Signer: ${wallet.address}`);
    console.log(`Funder: ${funder || 'not set'}`);

    const basicClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
    const creds = await basicClient.createOrDeriveApiKey();
    console.log(`API Key: ${creds.key?.slice(0, 8)}...`);

    clobClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds, signatureType, funder);

    const balance = await clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    cachedBalance = parseFloat(balance.balance || '0') / 1_000_000;
    console.log(`Balance: $${cachedBalance.toFixed(2)} USDC`);

    return true;
  } catch (error: any) {
    console.error('Init failed:', error.message);
    return false;
  }
}

async function getPosition(tokenId: string): Promise<number> {
  if (!clobClient) return 0;
  try {
    const bal = await clobClient.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    return Math.floor(parseFloat(bal.balance || '0') / 1_000_000);
  } catch {
    return 0;
  }
}

async function getBothPositions(upTokenId: string, downTokenId: string): Promise<{up: number, down: number}> {
  const [up, down] = await Promise.all([
    getPosition(upTokenId),
    getPosition(downTokenId)
  ]);
  return { up, down };
}

async function cancelAllOrders(): Promise<void> {
  if (!clobClient) return;
  try {
    const openOrders = await clobClient.getOpenOrders();
    if (openOrders && openOrders.length > 0) {
      console.log(`   🧹 Cancelling ${openOrders.length} orders...`);
      await Promise.all(openOrders.map(o => clobClient!.cancelOrder({ orderID: o.id })));
    }
  } catch {}
}

/**
 * TRUE MARKET BUY - price $0.99 takes any ask INSTANTLY
 */
async function marketBuy(tokenId: string, shares: number, label: string): Promise<{orderId: string | null, filled: number}> {
  if (!clobClient) return { orderId: null, filled: 0 };
  
  const startTime = Date.now();
  const startPos = await getPosition(tokenId);
  
  console.log(`   📥 ${label}: MARKET BUY ${shares}`);
  
  try {
    const result = await clobClient.createAndPostOrder({
      tokenID: tokenId,
      price: 0.99, // TRUE MARKET ORDER - takes any ask
      size: shares,
      side: Side.BUY,
    }).catch(e => ({ error: e }));

    const orderId = result && !('error' in result) ? (result as any).orderID : null;
    const orderTime = Date.now() - startTime;
    
    if (!orderId) {
      const err = (result as any)?.error;
      console.log(`   ❌ ${label}: Failed (${orderTime}ms) - ${err?.data?.error || err?.message || 'Unknown'}`);
      return { orderId: null, filled: 0 };
    }
    
    // Market orders fill instantly - check immediately
    // Try order status first (most accurate)
    let filled = 0;
    try {
      const order = await clobClient.getOrder(orderId);
      if (order) {
        filled = Math.floor(parseFloat((order as any).size_matched || '0'));
      }
    } catch {}
    
    // Cancel any unfilled remainder
    try { await clobClient.cancelOrder({ orderID: orderId }); } catch {}
    
    // Double-check with position if order status showed 0
    if (filled === 0) {
      const endPos = await getPosition(tokenId);
      filled = endPos - startPos;
    }
    
    const totalTime = Date.now() - startTime;
    console.log(`   ✓ ${label}: ${filled} shares (${totalTime}ms)`);
    return { orderId, filled };
    
  } catch (error: any) {
    console.log(`   ❌ ${label}: ${error.message}`);
    return { orderId: null, filled: 0 };
  }
}

/**
 * MARKET SELL at $0.01 
 */
async function marketSell(tokenId: string, shares: number, label: string): Promise<boolean> {
  if (!clobClient || shares <= 0) return true;
  
  console.log(`   📤 ${label}: MARKET SELL ${shares} @ $0.01`);
  
  // Must wait for settlement
  await new Promise(r => setTimeout(r, SETTLEMENT_WAIT_MS));
  
  try {
    const result = await clobClient.createAndPostOrder({
      tokenID: tokenId,
      price: 0.01,
      size: shares,
      side: Side.SELL,
    }).catch(e => ({ error: e }));

    if (!result || 'error' in result) {
      const err = (result as any)?.error;
      console.log(`   ❌ ${label}: Sell failed - ${err?.data?.error || err?.message || 'Unknown'}`);
      return false;
    }
    
    // Wait for sell to process
    await new Promise(r => setTimeout(r, 1000));
    
    const remaining = await getPosition(tokenId);
    if (remaining === 0) {
      console.log(`   ✓ ${label}: Sold all`);
      return true;
    } else {
      console.log(`   ⚠️ ${label}: ${remaining} remaining`);
      return false;
    }
  } catch (e: any) {
    console.log(`   ❌ ${label}: ${e.message}`);
    return false;
  }
}

async function reverseToZero(upTokenId: string, downTokenId: string): Promise<boolean> {
  await cancelAllOrders();
  
  const pos = await getBothPositions(upTokenId, downTokenId);
  console.log(`   🔄 Reversing: ${pos.up} UP, ${pos.down} DOWN`);
  
  let success = true;
  if (pos.up > 0) {
    if (!await marketSell(upTokenId, pos.up, 'UP')) success = false;
  }
  if (pos.down > 0) {
    if (!await marketSell(downTokenId, pos.down, 'DOWN')) success = false;
  }
  
  const final = await getBothPositions(upTokenId, downTokenId);
  if (final.up === 0 && final.down === 0) {
    console.log(`   ✅ Reversed to 0`);
    return true;
  }
  
  console.log(`   ❌ Still have: ${final.up} UP, ${final.down} DOWN`);
  return false;
}

/**
 * FAST SEQUENTIAL EXECUTE
 */
export async function executeTrade(arb: ArbitrageOpportunity): Promise<ExecutedTrade | null> {
  if (!clobClient || !wallet) return null;
  if (brokenMarkets.has(arb.market_id) || completedMarkets.has(arb.market_id)) return null;

  const startTime = Date.now();
  
  const trade: ExecutedTrade = {
    id: `trade-${Date.now()}`,
    market_id: arb.market_id,
    shares: 0,
    status: 'failed',
    has_exposure: false,
    can_retry: true,
  };

  await cancelAllOrders();
  
  // Check starting position
  const startPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
  if (startPos.up !== startPos.down) {
    console.log(`   ⚠️ Pre-existing imbalance: ${startPos.up} UP, ${startPos.down} DOWN`);
    if (!await reverseToZero(arb.up_token_id, arb.down_token_id)) {
      brokenMarkets.add(arb.market_id);
      trade.has_exposure = true;
      trade.can_retry = false;
      trade.error = 'Could not reverse';
      executedTrades.push(trade);
      return trade;
    }
  }

  console.log(`\n   ⚡ MARKET ORDERS: ${MIN_SHARES} shares`);

  // STEP 1: Market buy DOWN
  const downResult = await marketBuy(arb.down_token_id, MIN_SHARES, 'DOWN');
  
  if (downResult.filled === 0) {
    console.log(`   ⚠️ No DOWN fills - retrying...`);
    trade.error = 'No DOWN fills';
    trade.can_retry = true;
    executedTrades.push(trade);
    return trade;
  }

  // STEP 2: Market buy EXACT same UP
  console.log(`   📊 Got ${downResult.filled} DOWN → buying ${downResult.filled} UP`);
  const upResult = await marketBuy(arb.up_token_id, downResult.filled, 'UP');
  
  // FINAL CHECK
  const finalPos = await getBothPositions(arb.up_token_id, arb.down_token_id);
  const totalTime = Date.now() - startTime;
  
  console.log(`\n   📊 FINAL: ${finalPos.up} UP, ${finalPos.down} DOWN (${totalTime}ms)`);

  if (finalPos.up === finalPos.down && finalPos.up > 0) {
    console.log(`   ✅✅ SUCCESS! ${finalPos.up} each`);
    completedMarkets.add(arb.market_id);
    trade.status = 'filled';
    trade.shares = finalPos.up;
    trade.has_exposure = false;
    trade.can_retry = false;
    executedTrades.push(trade);
    return trade;
  }
  
  // IMBALANCED
  console.log(`   🚨 Imbalanced! Reversing...`);
  if (await reverseToZero(arb.up_token_id, arb.down_token_id)) {
    trade.error = 'Reversed';
    trade.can_retry = true;
  } else {
    brokenMarkets.add(arb.market_id);
    trade.has_exposure = true;
    trade.can_retry = false;
    trade.error = 'Reversal failed';
  }
  
  executedTrades.push(trade);
  return trade;
}

export function getExecutionStats() {
  const filled = executedTrades.filter(t => t.status === 'filled');
  return {
    total_trades: executedTrades.length,
    successful_trades: filled.length,
    failed_trades: executedTrades.length - filled.length,
    total_cost: 0,
    total_profit: 0,
    pending_payout: 0,
  };
}

export function isTraderReady(): boolean {
  return clobClient !== null && wallet !== null;
}

export async function getBalance(): Promise<number> {
  return cachedBalance;
}
