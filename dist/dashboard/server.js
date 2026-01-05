/**
 * Dashboard Web Server
 * BTC Up/Down Arbitrage Bot
 */
import express from 'express';
import { EventEmitter } from 'events';
// Global event emitter for log streaming
export const dashboardEvents = new EventEmitter();
dashboardEvents.setMaxListeners(100);
// Store recent logs
const recentLogs = [];
const MAX_LOGS = 500;
let stats = {
    status: 'initializing',
    startTime: Date.now(),
    scanCount: 0,
    marketsCount: 0,
    arbsFound: 0,
    paperTrades: 0,
    totalProfit: 0,
    totalCost: 0,
    pendingPayout: 0,
    bestArb: null,
    lastScan: 'Never',
};
/**
 * Push a log message
 */
export function pushLog(message) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const logLine = `[${timestamp}] ${message}`;
    recentLogs.push(logLine);
    if (recentLogs.length > MAX_LOGS) {
        recentLogs.shift();
    }
    dashboardEvents.emit('log', logLine);
}
/**
 * Update stats
 */
export function updateStats(update) {
    stats = { ...stats, ...update };
    dashboardEvents.emit('stats', stats);
}
/**
 * Get current stats
 */
export function getStats() {
    return { ...stats };
}
/**
 * Start dashboard server
 */
export function startDashboardServer(port = 3000) {
    const app = express();
    app.get('/', (_req, res) => {
        res.send(getDashboardHTML());
    });
    app.get('/api/stats', (_req, res) => {
        res.json(stats);
    });
    app.get('/api/logs', (_req, res) => {
        res.json(recentLogs);
    });
    app.get('/api/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.write(`event: stats\ndata: ${JSON.stringify(stats)}\n\n`);
        for (const log of recentLogs.slice(-50)) {
            res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`);
        }
        const onLog = (log) => {
            res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`);
        };
        const onStats = (newStats) => {
            res.write(`event: stats\ndata: ${JSON.stringify(newStats)}\n\n`);
        };
        dashboardEvents.on('log', onLog);
        dashboardEvents.on('stats', onStats);
        req.on('close', () => {
            dashboardEvents.off('log', onLog);
            dashboardEvents.off('stats', onStats);
        });
    });
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://0.0.0.0:${port}`);
    });
    return app;
}
/**
 * Dashboard HTML
 */
function getDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BTC Up/Down Arb Bot</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0d1117;
      --bg-card: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --text-dim: #8b949e;
      --green: #3fb950;
      --yellow: #d29922;
      --red: #f85149;
      --blue: #58a6ff;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Inter', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 0;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-icon {
      font-size: 28px;
    }

    .logo h1 {
      font-size: 20px;
      font-weight: 700;
    }

    .logo span {
      color: var(--text-dim);
      font-size: 14px;
      font-weight: 400;
    }

    .status {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: var(--bg-card);
      border-radius: 20px;
      border: 1px solid var(--border);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      animation: pulse 2s infinite;
    }

    .status-dot.stopped { background: var(--red); animation: none; }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }

    .stat {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }

    .stat-label {
      color: var(--text-dim);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }

    .stat-value {
      font-size: 28px;
      font-weight: 700;
      font-family: 'JetBrains Mono', monospace;
    }

    .stat-value.green { color: var(--green); }
    .stat-value.yellow { color: var(--yellow); }

    .log-box {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }

    .log-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: rgba(0,0,0,0.2);
      border-bottom: 1px solid var(--border);
    }

    .log-header h2 {
      font-size: 14px;
      font-weight: 600;
    }

    .log-header button {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-dim);
      padding: 4px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
    }

    .log-header button:hover {
      background: var(--border);
      color: var(--text);
    }

    .logs {
      height: 450px;
      overflow-y: auto;
      padding: 12px 16px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      line-height: 1.6;
    }

    .log-line {
      padding: 2px 0;
    }

    .log-line.arb {
      color: var(--green);
      background: rgba(63, 185, 80, 0.1);
      padding: 4px 8px;
      margin: 4px -8px;
      border-radius: 4px;
    }

    .log-line .time { color: var(--text-dim); }

    footer {
      text-align: center;
      padding: 24px;
      color: var(--text-dim);
      font-size: 12px;
    }

    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo">
        <span class="logo-icon">₿</span>
        <div>
          <h1>BTC Up/Down Arb Bot</h1>
          <span>LIVE TRADING - $5/trade</span>
        </div>
      </div>
      <div class="status">
        <div class="status-dot" id="dot"></div>
        <span id="statusText">Connecting...</span>
      </div>
    </header>

    <div class="stats">
      <div class="stat">
        <div class="stat-label">Runtime</div>
        <div class="stat-value" id="runtime">0:00:00</div>
      </div>
      <div class="stat">
        <div class="stat-label">Scans</div>
        <div class="stat-value" id="scans">0</div>
      </div>
      <div class="stat">
        <div class="stat-label">Markets</div>
        <div class="stat-value" id="markets">0</div>
      </div>
      <div class="stat">
        <div class="stat-label">Arbs Found</div>
        <div class="stat-value yellow" id="arbs">0</div>
      </div>
      <div class="stat">
        <div class="stat-label">Total Cost</div>
        <div class="stat-value" id="cost">$0.00</div>
      </div>
      <div class="stat">
        <div class="stat-label">Pending Payout</div>
        <div class="stat-value yellow" id="payout">$0.00</div>
      </div>
      <div class="stat">
        <div class="stat-label">Locked Profit</div>
        <div class="stat-value green" id="profit">$0.00</div>
      </div>
    </div>

    <div class="log-box">
      <div class="log-header">
        <h2>Live Scanner</h2>
        <button onclick="clearLogs()">Clear</button>
      </div>
      <div class="logs" id="logs">
        <div class="log-line">Connecting...</div>
      </div>
    </div>

    <footer>
      BTC Up/Down 15-Min Arbitrage • LIVE TRADING $5/trade • Buy Both + Hold to Expiry
    </footer>
  </div>

  <script>
    let autoScroll = true;
    const logs = document.getElementById('logs');

    function formatTime(ms) {
      const s = Math.floor(ms / 1000);
      return Math.floor(s / 3600) + ':' + 
        String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ':' + 
        String(s % 60).padStart(2, '0');
    }

    function updateStats(s) {
      document.getElementById('dot').className = 'status-dot' + (s.status === 'running' ? '' : ' stopped');
      document.getElementById('statusText').textContent = s.status.charAt(0).toUpperCase() + s.status.slice(1);
      document.getElementById('runtime').textContent = formatTime(Date.now() - s.startTime);
      document.getElementById('scans').textContent = s.scanCount.toLocaleString();
      document.getElementById('markets').textContent = s.marketsCount;
      document.getElementById('arbs').textContent = s.arbsFound;
      document.getElementById('cost').textContent = '$' + (s.totalCost || 0).toFixed(2);
      document.getElementById('payout').textContent = '$' + (s.pendingPayout || 0).toFixed(2);
      document.getElementById('profit').textContent = '$' + s.totalProfit.toFixed(2);
    }

    function addLog(msg) {
      const div = document.createElement('div');
      div.className = 'log-line' + (msg.includes('ARB') || msg.includes('🎯') ? ' arb' : '');
      div.innerHTML = msg.replace(/^\\[(\\d{2}:\\d{2}:\\d{2})\\]/, '<span class="time">[$1]</span>');
      logs.appendChild(div);
      while (logs.children.length > 500) logs.removeChild(logs.firstChild);
      if (autoScroll) logs.scrollTop = logs.scrollHeight;
    }

    function clearLogs() { logs.innerHTML = '<div class="log-line">Cleared</div>'; }

    function connect() {
      const es = new EventSource('/api/stream');
      es.addEventListener('log', e => addLog(JSON.parse(e.data)));
      es.addEventListener('stats', e => updateStats(JSON.parse(e.data)));
      es.onerror = () => {
        document.getElementById('statusText').textContent = 'Disconnected';
        document.getElementById('dot').className = 'status-dot stopped';
        setTimeout(connect, 3000);
      };
    }

    setInterval(() => fetch('/api/stats').then(r => r.json()).then(updateStats).catch(() => {}), 1000);
    connect();
  </script>
</body>
</html>`;
}
//# sourceMappingURL=server.js.map