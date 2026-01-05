# BTC Up/Down 15-Minute Arbitrage Bot

Paper trading bot for Polymarket BTC Up/Down markets.

## Strategy

Buy BOTH sides (Up + Down) when:
```
buy_up_price + buy_down_price < 1.00 - MIN_EDGE (2%)
```

Hold both to expiry → Collect $1 guaranteed.

**Phase 1: Paper Trading Only - NO real orders.**

## How It Works

1. Scans BTC Up/Down 15-minute markets
2. Fetches orderbook prices (best asks)
3. Detects when combined cost < $0.98
4. Simulates paper trade
5. Tracks persistence and profitability

## Web Dashboard

Live dashboard at `http://localhost:3000` shows:
- Runtime and scan count
- Markets monitored
- Arbs found and paper profit
- Real-time log stream

## Installation

```bash
npm install
npm run build
```

## Usage

```bash
npm start
```

Dashboard opens at `http://localhost:3000`

## Configuration

Edit `src/config/constants.ts`:

| Setting | Default | Description |
|---------|---------|-------------|
| `MIN_EDGE` | 0.02 | 2% minimum edge required |
| `EXPIRY_CUTOFF_SECONDS` | 120 | Skip last 2 min before expiry |
| `PAPER_MAX_SHARES` | 100 | Max shares per paper trade |
| `SCAN_INTERVAL_MS` | 3000 | Scan every 3 seconds |

## Output Files

Data saved to `./data/`:

| File | Content |
|------|---------|
| `arbitrage_log.csv` | All arb opportunities |
| `arbitrage_log.json` | Same in JSON |
| `paper_trades.json` | Simulated trades |
| `scan_stats.json` | Scan statistics |

## Phase 1 Goals

After 7 days, answer:
- How many BTC Up/Down arbs occur per day?
- How large are they?
- How early before expiry do they appear?
- How long do they persist?
- Is liquidity sufficient?

## Project Structure

```
src/
├── crypto/
│   ├── scanner.ts      # BTC Up/Down market discovery
│   ├── arbitrage.ts    # Arb detection logic
│   ├── paper-trader.ts # Trade simulation
│   ├── persistence.ts  # Duration tracking
│   └── arb-logger.ts   # CSV/JSON logging
├── dashboard/
│   └── server.ts       # Web dashboard
├── config/constants.ts
├── logger/logger.ts
├── types/arbitrage.ts
└── index.ts
```

## Replit Deployment

The `.replit` file is configured to:
- Build and run the bot
- Expose port 3000 for the dashboard

## License

MIT
