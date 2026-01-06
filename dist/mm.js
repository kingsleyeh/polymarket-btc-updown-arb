/**
 * MARKET MAKER ENTRY POINT
 *
 * Run with: npm run mm
 */
import * as dotenv from 'dotenv';
import { initializeMarketMaker, startMarketMaker, stopMarketMaker } from './execution/market-maker';
import { scanBTCUpDownMarkets } from './crypto/scanner';
dotenv.config();
async function main() {
    console.log('\n==========================================');
    console.log('   BTC UP/DOWN MARKET MAKER - Phase 1');
    console.log('==========================================\n');
    // Initialize
    const initialized = await initializeMarketMaker();
    if (!initialized) {
        console.error('Failed to initialize market maker');
        process.exit(1);
    }
    // Find active market
    console.log('\nScanning for BTC Up/Down 15-minute markets...');
    const markets = await scanBTCUpDownMarkets();
    if (markets.length === 0) {
        console.log('No active BTC Up/Down markets found');
        process.exit(1);
    }
    // Pick the market with most time remaining
    const market = markets.reduce((best, m) => {
        const bestExpiry = best.expiry_timestamp || 0;
        const mExpiry = m.expiry_timestamp || 0;
        return mExpiry > bestExpiry ? m : best;
    }, markets[0]);
    const timeToExpiry = market.expiry_timestamp
        ? Math.round((new Date(market.expiry_timestamp).getTime() - Date.now()) / 60000)
        : 0;
    console.log(`\nSelected market: ${market.question}`);
    console.log(`Time to expiry: ${timeToExpiry} minutes`);
    console.log(`UP token: ${market.up_token_id}`);
    console.log(`DOWN token: ${market.down_token_id}`);
    // Handle shutdown
    process.on('SIGINT', () => {
        console.log('\n\nShutting down...');
        stopMarketMaker();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        console.log('\n\nShutting down...');
        stopMarketMaker();
        process.exit(0);
    });
    // Start market making
    await startMarketMaker(market.id, market.up_token_id, market.down_token_id, market.question);
}
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
//# sourceMappingURL=mm.js.map