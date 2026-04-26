const express = require('express');
const { Server } = require('socket.io');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const server = require('http').createServer(app);
const io = new Server(server);

const PORT = 4000;
const MINERS_FILE = path.join(__dirname, 'miners.json');
const POLL_INTERVAL = 4000;

let miners = [];
let stats = {};
let lastBestDiff = {};      // previous bestDiff
let initialBestSet = {};    // track if we've seen the first real bestDiff

async function loadMiners() {
  if (await fs.pathExists(MINERS_FILE)) {
    miners = await fs.readJson(MINERS_FILE);
  } else {
    await fs.writeJson(MINERS_FILE, []);
  }
}

async function saveMiners() {
  await fs.writeJson(MINERS_FILE, miners, { spaces: 2 });
}

async function fetchBitaxe(ip) {
  try {
    const res = await axios.get(`http://${ip}/api/system/info`, { timeout: 7000 });
    const d = res.data;
    return {
      online: true,
      hashrate: parseFloat(d.hashRate || 0),
      temp: parseFloat(d.temp || 0),
      vrTemp: parseFloat(d.vrTemp || d.temp2 || 0),
      power: parseFloat(d.power || 0),
      efficiency: (d.power && d.hashRate) ? (d.power / d.hashRate).toFixed(2) : '—',
      bestDiff: parseFloat(d.bestDiff || 0)
    };
  } catch (e) {
    return { online: false };
  }
}

async function pollAll() {
  const newStats = {};

  for (const miner of miners) {
    const data = await fetchBitaxe(miner.ip);
    newStats[miner.id] = data;

    const currentBest = data.bestDiff || 0;
    const previousBest = lastBestDiff[miner.id] || 0;

    // Only check for block after we've seen the first real bestDiff
    if (!initialBestSet[miner.id]) {
      if (currentBest > 100000) {  // reasonable first bestDiff threshold
        initialBestSet[miner.id] = true;
        lastBestDiff[miner.id] = currentBest;
      }
      continue;
    }

    // Real block detection: needs a significant jump after initial bestDiff is set
    if (currentBest > previousBest * 5 && currentBest > 500000000) {  // 5x jump + very high diff
      console.log(`🎉 REAL BLOCK LIKELY FOUND on ${miner.name} (${miner.ip}) - bestDiff: ${currentBest}`);
      io.emit('blockFound', {
        minerName: miner.name,
        hashrate: data.hashrate || 0
      });
    }

    lastBestDiff[miner.id] = currentBest;
  }

  stats = newStats;
  io.emit('update', { miners, stats });
}

// Control endpoint (unchanged)
app.post('/api/control/:id', async (req, res) => {
  const miner = miners.find(m => m.id === req.params.id);
  if (!miner) return res.status(404).json({ error: 'Miner not found' });

  const action = req.body?.action;
  if (!action) return res.status(400).json({ error: 'No action provided' });

  console.log(`[CONTROL] ${action} for ${miner.ip}`);

  try {
    if (action === 'restart') {
      await axios.post(`http://${miner.ip}/api/system/restart`);
      return res.json({ success: true });
    } else if (action === 'turbo') {
      await axios.patch(`http://${miner.ip}/api/system`, { frequency: 650, coreVoltage: 1250 });
      return res.json({ success: true });
    } else if (action === 'eco') {
      await axios.patch(`http://${miner.ip}/api/system`, { frequency: 450, coreVoltage: 1100 });
      return res.json({ success: true });
    }
    res.json({ success: false });
  } catch (e) {
    console.error(`Control error:`, e.message);
    res.status(500).json({ error: 'Command failed' });
  }
});

app.use(express.static('public'));
app.use(express.json());

app.get('/api/miners', (req, res) => res.json({ miners, stats }));

app.post('/api/miners', async (req, res) => {
  const { name, ip } = req.body;
  if (!name || !ip) return res.status(400).json({ error: 'name and ip required' });

  const id = Date.now().toString();
  miners.push({ id, name, ip });
  await saveMiners();
  res.json({ success: true });
  setTimeout(pollAll, 800);
});

app.delete('/api/miners/:id', async (req, res) => {
  miners = miners.filter(m => m.id !== req.params.id);
  delete stats[req.params.id];
  delete lastBestDiff[req.params.id];
  delete initialBestSet[req.params.id];
  await saveMiners();
  res.json({ success: true });
});

loadMiners().then(() => {
  pollAll();
  setInterval(pollAll, POLL_INTERVAL);

  server.listen(PORT, () => {
    console.log(`🚀 Hash-Dashboard running at http://localhost:${PORT}`);
  });
});
