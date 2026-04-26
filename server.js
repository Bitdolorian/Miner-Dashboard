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

let miners = [];
let stats = {};

async function loadMiners() {
  if (await fs.pathExists(MINERS_FILE)) miners = await fs.readJson(MINERS_FILE);
  else await fs.writeJson(MINERS_FILE, []);
}

async function saveMiners() {
  await fs.writeJson(MINERS_FILE, miners, { spaces: 2 });
}

// Simple fetch
async function fetchBitaxe(ip) {
  try {
    const res = await axios.get(`http://${ip}/api/system/info`, { timeout: 6000 });
    const d = res.data;
    return {
      online: true,
      hashrate: parseFloat(d.hashRate || 0),
      temp: parseFloat(d.temp || 0),
      vrTemp: parseFloat(d.vrTemp || d.temp2 || 0),
      power: parseFloat(d.power || 0),
      efficiency: (d.power && d.hashRate) ? (d.power / d.hashRate).toFixed(2) : '—'
    };
  } catch (e) {
    return { online: false };
  }
}

async function pollAll() {
  const newStats = {};
  for (const miner of miners) {
    newStats[miner.id] = await fetchBitaxe(miner.ip);
  }
  stats = newStats;
  io.emit('update', { miners, stats });
}

// Super simple control for debugging
app.post('/api/control/:id', async (req, res) => {
  const miner = miners.find(m => m.id === req.params.id);
  if (!miner) return res.status(404).json({ error: 'Miner not found' });

  const action = req.body?.action || 'unknown';
  console.log(`[CONTROL DEBUG] Action "${action}" requested for ${miner.ip}`);

  // Just test if we can reach the restart endpoint
  try {
    const testUrl = `http://${miner.ip}/api/system/restart`;
    console.log(`[CONTROL DEBUG] Testing ${testUrl}`);
    const response = await axios.post(testUrl, {}, { timeout: 8000 });
    console.log(`[CONTROL DEBUG] Success: ${JSON.stringify(response.data)}`);
    return res.json({ success: true, message: 'Restart command sent successfully' });
  } catch (e) {
    console.error(`[CONTROL DEBUG] Failed: ${e.message}`);
    return res.status(500).json({ error: `Command failed: ${e.message}` });
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

loadMiners().then(() => {
  pollAll();
  setInterval(pollAll, 4000);
  server.listen(PORT, () => {
    console.log(`🚀 Hash-Dashboard running at http://localhost:${PORT}`);
  });
});
