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

async function loadMiners() {
  if (await fs.pathExists(MINERS_FILE)) miners = await fs.readJson(MINERS_FILE);
  else await fs.writeJson(MINERS_FILE, []);
}

async function saveMiners() {
  await fs.writeJson(MINERS_FILE, miners, { spaces: 2 });
}

// Fetch data
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

// Control - simple and direct
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
    } 
    else if (action === 'turbo') {
      await axios.patch(`http://${miner.ip}/api/system`, { frequency: 650, coreVoltage: 1250 });
      return res.json({ success: true });
    } 
    else if (action === 'eco') {
      await axios.patch(`http://${miner.ip}/api/system`, { frequency: 450, coreVoltage: 1100 });
      return res.json({ success: true });
    }
    res.json({ success: false });
  } catch (e) {
    console.error(`Control error: ${e.message}`);
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
