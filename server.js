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

// AxeOS
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

// CGMiner - Improved Best Diff / Best Share extraction
async function fetchCGMiner(ip) {
  return new Promise((resolve) => {
    const client = new net.Socket();
    let buffer = '';

    client.setTimeout(10000);

    client.connect(4028, ip, () => {
      client.write('{"command":"summary+stats"}');
    });

    client.on('data', (chunk) => {
      buffer += chunk.toString();
    });

    client.on('end', () => {
      try {
        // Hashrate
        let hashrate = 0;
        const mhsMatch = buffer.match(/MHS 5s["\s:]*([\d.]+)/);
        if (mhsMatch) hashrate = parseFloat(mhsMatch[1]) / 1000;

        // Temperature
        let temp = 0;
        const tempMatch = buffer.match(/Temp["\s:]*([\d.]+)/i) || buffer.match(/LastTemp["\s:]*([\d.]+)/i);
        if (tempMatch) temp = parseFloat(tempMatch[1]);

        // Power
        let power = 0;
        const powerMatch = buffer.match(/Power["\s:]*([\d.]+)/i) || buffer.match(/Iout["\s:]*([\d.]+)/i);
        if (powerMatch) power = parseFloat(powerMatch[1]);

        // Best Diff / Best Share extraction
        let bestDiff = 0;

        // Look for "Best Share" field
        const bestShareMatch = buffer.match(/Best Share["\s:]*([\d.]+[KMBT]?)/i);
        if (bestShareMatch) {
          let val = bestShareMatch[1].toUpperCase();
          let num = parseFloat(val.replace(/[KMBT]/, ''));
          if (val.includes('K')) num *= 1000;
          if (val.includes('M')) num *= 1000000;
          if (val.includes('B')) num *= 1000000000;
          bestDiff = num;
        }

        // Fallback: any "Diff XX.XK" or "XX.XK" patterns
        if (bestDiff === 0) {
          const diffRegex = /(?:Diff|Share)["\s:=]*(\d+\.?\d*[KMBT]?)/gi;
          let match;
          while ((match = diffRegex.exec(buffer)) !== null) {
            let val = match[1].toUpperCase();
            let num = parseFloat(val.replace(/[KMBT]/, ''));
            if (val.includes('K')) num *= 1000;
            if (val.includes('M')) num *= 1000000;
            if (val.includes('B')) num *= 1000000000;
            if (num > bestDiff) bestDiff = num;
          }
        }

        console.log(`[CGMiner] ${ip} → ${hashrate.toFixed(1)} GH/s | Temp: ${temp.toFixed(1)}°C | Power: ${power.toFixed(2)}W | Best Diff: ${bestDiff}`);

        resolve({
          online: true,
          hashrate,
          temp,
          vrTemp: 0,
          power,
          efficiency: (power && hashrate) ? (power / hashrate).toFixed(2) : '—',
          bestDiff: bestDiff,
          isUsingFallbackStratum: 0,
          type: 'cgminer'
        });
      } catch (e) {
        console.log(`[CGMiner Parse Error] ${ip}`);
        resolve({ online: false });
      }
    });

    client.on('timeout', () => { client.destroy(); resolve({ online: false }); });
    client.on('error', () => resolve({ online: false }));
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
    newStats[miner.id] = await fetchMiner(miner.ip);
  }
  stats = newStats;
  io.emit('update', { miners, stats });
}

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
