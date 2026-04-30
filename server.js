const express = require('express');
const { Server } = require('socket.io');
const axios = require('axios');
const net = require('net');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const server = require('http').createServer(app);
const io = new Server(server);

const PORT = 4000;
const MINERS_FILE = path.join(__dirname, 'miners.json');
const POLL_INTERVAL = 6000;

let miners = [];
let stats = {};

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

// AxeOS Fetch
async function fetchAxeOS(ip) {
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
      bestDiff: parseFloat(d.bestDiff || d.bestSessionDiff || 0),
      isUsingFallbackStratum: d.isUsingFallbackStratum || 0,
      type: 'axeos'
    };
  } catch (e) {
    return { online: false };
  }
}

// Improved CGMiner parser for your specific output
async function fetchCGMiner(ip) {
  return new Promise((resolve) => {
    const client = new net.Socket();
    let buffer = '';

    console.log(`[CGMiner] Connecting to ${ip}:4028`);

    client.setTimeout(10000);

    client.connect(4028, ip, () => {
      client.write('{"command":"summary+stats"}');
    });

    client.on('data', (chunk) => {
      buffer += chunk.toString();
    });

    client.on('end', () => {
      console.log(`[CGMiner] Received ${buffer.length} bytes from ${ip}`);

      try {
        // Clean the response
        let clean = buffer.replace(/\|/g, '').trim();
        // Remove any non-printable characters
        clean = clean.replace(/[^\x20-\x7E]/g, '');

        const json = JSON.parse(clean);

        const summary = json.summary?.[0]?.SUMMARY?.[0] || json.SUMMARY?.[0] || {};
        const stats = json.stats?.[0]?.STATS?.[1] || json.STATS?.[1] || json.STATS?.[0] || {};

        // Extract hashrate (MHS 5s is in MH/s)
        let hashrate = 0;
        if (summary['MHS 5s']) hashrate = parseFloat(summary['MHS 5s']) / 1000;   // convert to GH/s
        else if (summary['MHS av']) hashrate = parseFloat(summary['MHS av']) / 1000;

        const power = parseFloat(stats['Power'] || stats['Iout'] || 0);
        const temp = parseFloat(stats['Temp'] || stats['temp'] || stats['LastTemp'] || 0);

        console.log(`[CGMiner Success] ${ip} → ${hashrate.toFixed(1)} GH/s, ${temp}°C, ${power}W`);

        resolve({
          online: true,
          hashrate: hashrate,
          temp: temp,
          vrTemp: 0,
          power: power,
          efficiency: (power && hashrate) ? (power / hashrate).toFixed(2) : '—',
          bestDiff: 0,
          isUsingFallbackStratum: 0,
          type: 'cgminer'
        });
      } catch (e) {
        console.log(`[CGMiner Parse Error] ${ip}:`, e.message);
        resolve({ online: false });
      }
    });

    client.on('timeout', () => {
      console.log(`[CGMiner] Timeout on ${ip}`);
      client.destroy();
      resolve({ online: false });
    });

    client.on('error', (err) => {
      console.log(`[CGMiner] Error on ${ip}:`, err.message);
      resolve({ online: false });
    });
  });
}

async function fetchMiner(ip) {
  let data = await fetchAxeOS(ip);
  if (data.online) return data;
  return await fetchCGMiner(ip);
}

async function pollAll() {
  const newStats = {};

  for (const miner of miners) {
    const data = await fetchMiner(miner.ip);
    newStats[miner.id] = data;
  }

  stats = newStats;
  io.emit('update', { miners, stats });
}

// Simple control (restart works for AxeOS only for now)
app.post('/api/control/:id', async (req, res) => {
  const miner = miners.find(m => m.id === req.params.id);
  if (!miner) return res.status(404).json({ success: false });

  const { action } = req.body || {};
  console.log(`[CONTROL] ${action} for ${miner.ip}`);

  try {
    if (action === 'restart') {
      await axios.post(`http://${miner.ip}/api/system/restart`, {}, { timeout: 5000 }).catch(() => {});
      return res.json({ success: true });
    }
    res.json({ success: false });
  } catch (e) {
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
  setTimeout(pollAll, 1500);
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
