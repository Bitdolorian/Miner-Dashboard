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
let lastBestDiff = {};
let initialBestSet = {};
let lastRestartTime = {};   // Track when we sent a restart
let lastBlockTime = {};

app.use(express.json());

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
      bestDiff: parseFloat(d.bestDiff || 0),
      bestSessionDiff: parseFloat(d.bestSessionDiff || 0),
      isUsingFallbackStratum: d.isUsingFallbackStratum || 0
    };
  } catch (e) {
    return { online: false };
  }
}

async function pollAll() {
  const newStats = {};
  const now = Date.now();

  for (const miner of miners) {
    const data = await fetchBitaxe(miner.ip);
    newStats[miner.id] = data;

    const currentBest = Math.max(data.bestDiff || 0, data.bestSessionDiff || 0);
    const previousBest = lastBestDiff[miner.id] || 0;

    // Skip block detection right after a restart (60-second cooldown)
    const timeSinceRestart = now - (lastRestartTime[miner.id] || 0);
    if (timeSinceRestart < 60000) {
      lastBestDiff[miner.id] = currentBest;
      continue;
    }

    if (!initialBestSet[miner.id]) {
      if (currentBest > 5000000) {
        initialBestSet[miner.id] = true;
        lastBestDiff[miner.id] = currentBest;
      }
      continue;
    }

    // Very strict real block detection
    const timeSinceLastBlock = now - (lastBlockTime[miner.id] || 0);
    if (currentBest > previousBest * 15 && currentBest > 2000000000 && timeSinceLastBlock > 60000) {
      console.log(`🎉 REAL BLOCK FOUND on ${miner.name} (${miner.ip}) - bestDiff: ${currentBest}`);
      io.emit('blockFound', { minerName: miner.name, hashrate: data.hashrate || 0 });
      lastBlockTime[miner.id] = now;
    }

    lastBestDiff[miner.id] = currentBest;
  }

  stats = newStats;
  io.emit('update', { miners, stats });
}

// Control endpoint - track restart time
app.post('/api/control/:id', async (req, res) => {
  const miner = miners.find(m => m.id === req.params.id);
  if (!miner) return res.status(404).json({ success: false, error: 'Miner not found' });

  const { action, autofanspeed, fanspeed } = req.body || {};

  console.log(`[CONTROL] ${action} for ${miner.ip}`);

  try {
    if (action === 'restart') {
      lastRestartTime[miner.id] = Date.now();   // Mark restart time
      await axios.post(`http://${miner.ip}/api/system/restart`, {}, {
        headers: { 'Content-Type': 'application/json' }
      });
      console.log(`[CONTROL] Restart sent successfully to ${miner.ip}`);
      return res.json({ success: true });
    } 
    else if (action === 'turbo') {
      await axios.patch(`http://${miner.ip}/api/system`, { frequency: 650, coreVoltage: 1250 });
      return res.json({ success: true });
    } 
    else if (action === 'eco') {
      await axios.patch(`http://${miner.ip}/api/system`, { frequency: 450, coreVoltage: 1100 });
      return res.json({ success: true });
    } 
    else if (action === 'fan') {
      const payload = {};
      if (autofanspeed !== undefined) payload.autofanspeed = autofanspeed;
      if (fanspeed !== undefined) payload.fanspeed = fanspeed;
      await axios.patch(`http://${miner.ip}/api/system`, payload);
      return res.json({ success: true });
    }

    res.json({ success: false });
  } catch (e) {
    console.error(`[CONTROL ERROR] ${action} failed for ${miner.ip}:`, e.message);
    res.status(500).json({ success: false });
  }
});

app.use(express.static('public'));

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
  delete lastRestartTime[req.params.id];
  delete lastBlockTime[req.params.id];
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
