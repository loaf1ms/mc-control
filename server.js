#!/usr/bin/env node
/**
 * DroidMC — Full Minecraft Server Panel for Termux
 * Copyright (c) 2026 by Loaf1ms
 */

const express  = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');

let pidusage;
try { pidusage = require('pidusage'); } catch(e) { pidusage = null; }

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// --- State --------------------------------------------------------------------
let mcProcess     = null;
let logHistory    = [];
let onlinePlayers = {};   // name ? { name, joined }
let startTime     = null;
let downloadState = null;
let systemStats   = { cpu: 0, ram: 0, diskUsed: 0, diskTotal: 0 };

const CONFIG_FILE = path.join(process.env.HOME || '/data/data/com.termux/files/home', 'DroidMC', 'config.json');
const CONFIG_DEFAULTS = {
  serverJar: process.env.MC_JAR  || 'server.jar',
  serverDir: process.env.MC_DIR  || `${process.env.HOME || '/data/data/com.termux/files/home'}/minecraft`,
  memory:    process.env.MC_RAM  || '1G',
  javaPath:  process.env.JAVA    || 'java',
  uiPort:    parseInt(process.env.UI_PORT || '8080'),
  serverType: '',
  serverVersion: '',
};
function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return { ...CONFIG_DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch {}
  return { ...CONFIG_DEFAULTS };
}
function saveConfig() {
  try { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2)); }
  catch (e) { console.error('[config] save failed:', e.message); }
}
const CONFIG = loadConfig();

// --- Verbose terminal logging -------------------------------------------------
const VERBOSE = process.env.MC_VERBOSE === '1';
const ANSI = { reset:'\x1b[0m', dim:'\x1b[2m', green:'\x1b[32m', amber:'\x1b[33m', red:'\x1b[31m', blue:'\x1b[34m' };
function verbosePrint(text, type) {
  if (!VERBOSE) return;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const col = type==='warn'?ANSI.amber:type==='error'?ANSI.red:type==='system'?ANSI.green:type==='cmd'?ANSI.blue:ANSI.reset;
  process.stdout.write(`${ANSI.dim}${time}${ANSI.reset} ${col}${text}${ANSI.reset}\n`);
}

// --- Helpers ------------------------------------------------------------------
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

let _prevCpu = null;
function readCpuTimes() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = stat.trim().split(/\s+/);
    if (parts[0] === 'cpu' && parts.length >= 5) {
      const values = parts.slice(1).map(v => parseInt(v, 10)).filter(Number.isFinite);
      const idle = (values[3] || 0) + (values[4] || 0);
      const total = values.reduce((sum, value) => sum + value, 0);
      if (total > 0) return { idle, total };
    }
  } catch {}

  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  cpus.forEach(cpu => {
    for (const t in cpu.times) total += cpu.times[t];
    idle += cpu.times.idle;
  });
  return { idle, total };
}

function resolveStatsPath(targetPath) {
  let current = path.resolve(targetPath || __dirname);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return __dirname;
    current = parent;
  }
  return current;
}

function updateDiskStats() {
  try {
    const statPath = resolveStatsPath(CONFIG.serverDir);
    const stats = fs.statfsSync(statPath);
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    const total = Number(stats.blocks || 0) * blockSize;
    const free = Number((stats.bavail ?? stats.bfree) || 0) * blockSize;
    systemStats = {
      ...systemStats,
      diskUsed: Math.max(total - free, 0),
      diskTotal: total,
    };
  } catch {
    systemStats = { ...systemStats, diskUsed: 0, diskTotal: 0 };
  }
}

function updateSystemStats() {
  updateDiskStats();
  // If pidusage is available and MC is running, use process-level stats
  if (mcProcess && mcProcess.pid && pidusage) {
    pidusage(mcProcess.pid, (err, stats) => {
      if (!err && stats) {
        systemStats = {
          ...systemStats,
          cpu: parseFloat(stats.cpu.toFixed(1)),
          ram: parseFloat((stats.memory / 1024 / 1024).toFixed(1)), // MB
        };
      } else {
        // fallback to system stats on error
        _updateSystemStatsFallback();
      }
      broadcast({ type: 'stats', ...systemStats });
    });
  } else if (mcProcess && mcProcess.pid) {
    _updateSystemStatsFallback();
    broadcast({ type: 'stats', ...systemStats });
  } else {
    systemStats = { ...systemStats, cpu: 0, ram: 0 };
    broadcast({ type: 'stats', ...systemStats });
  }
}

function _updateSystemStatsFallback() {
  const totMem = os.totalmem(), freeMem = os.freemem();
  const { idle, total } = readCpuTimes();
  let cpuUsage = 0;
  if (_prevCpu) {
    const dIdle = idle - _prevCpu.idle, dTotal = total - _prevCpu.total;
    cpuUsage = dTotal > 0 ? 100 * (1 - dIdle / dTotal) : 0;
  }
  _prevCpu = { idle, total };
  if (cpuUsage < 0) cpuUsage = 0;
  if (cpuUsage > 100) cpuUsage = 100;
  // Return RAM in MB (used RAM of total)
  const usedMB = (totMem - freeMem) / 1024 / 1024;
  systemStats = {
    ...systemStats,
    cpu: Math.round(cpuUsage * 10) / 10,
    ram: Math.round(usedMB), // MB
  };
}

function addLog(raw, type = 'log') {
  const text = String(raw).replace(/\r/g, '').trim();
  if (!text) return;
  verbosePrint(text, type);

  const joinMatch  = text.match(/:\s+(\w+) joined the game/);
  const leaveMatch = text.match(/:\s+(\w+) left the game/);
  const listMatch  = text.match(/There are \d+ of a max of \d+ players online:(.*)/);

  if (joinMatch) {
    onlinePlayers[joinMatch[1]] = { name: joinMatch[1], joined: Date.now() };
    broadcast({ type: 'players', players: Object.values(onlinePlayers) });
  }
  if (leaveMatch) {
    delete onlinePlayers[leaveMatch[1]];
    broadcast({ type: 'players', players: Object.values(onlinePlayers) });
  }
  if (listMatch) {
    const names = listMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    onlinePlayers = {};
    names.forEach(n => { if (n) onlinePlayers[n] = { name: n, joined: Date.now() }; });
    broadcast({ type: 'players', players: Object.values(onlinePlayers) });
  }

  const entry = { text, type, time: new Date().toLocaleTimeString('en-US', { hour12: false }) };
  logHistory.push(entry);
  if (logHistory.length > 2000) logHistory.shift();
  broadcast({ type: 'log', ...entry });
}

function getUptime() {
  if (!startTime) return null;
  const s = Math.floor((Date.now() - startTime) / 1000);
  return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

function getNetworkInfo() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || entry.family !== 'IPv4') continue;
      addresses.push(entry.address);
    }
  }

  const lanIp = addresses.find(ip =>
    ip.startsWith('192.168.') ||
    ip.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  ) || addresses[0] || '127.0.0.1';

  return { lanIp, addresses };
}

function httpsGet(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'DroidMC/2.0 (termux-panel)' } }, res => {
      if (res.statusCode >= 300 && res.headers.location)
        return httpsGet(res.headers.location, depth + 1).then(resolve).catch(reject);
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    }).on('error', reject);
  });
}

function downloadFileWithProgress(url, outPath) {
  return new Promise((resolve, reject) => {
    const doGet = (sourceUrl, depth = 0) => {
      if (depth > 5) return reject(new Error('Too many redirects'));
      const mod = sourceUrl.startsWith('https') ? https : http;
      mod.get(sourceUrl, { headers: { 'User-Agent': 'DroidMC/2.0' } }, response => {
        if (response.statusCode >= 300 && response.headers.location)
          return doGet(response.headers.location, depth + 1);
        if (response.statusCode !== 200)
          return reject(new Error(`HTTP ${response.statusCode}`));

        downloadState.total = parseInt(response.headers['content-length'] || '0');
        let received = 0;
        const out = fs.createWriteStream(outPath);
        response.on('data', chunk => {
          received += chunk.length;
          downloadState.progress = received;
          broadcast({ type: 'download', ...downloadState });
        });
        response.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        response.on('error', reject);
      }).on('error', reject);
    };

    doGet(url);
  });
}

function runLoggedProcess(command, args, cwd, failureLabel) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd });
    proc.stdout.on('data', d => String(d).split('\n').forEach(l => { if (l.trim()) addLog(l.trim(), 'system'); }));
    proc.stderr.on('data', d => String(d).split('\n').forEach(l => { if (l.trim()) addLog(l.trim(), 'warn'); }));
    proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`${failureLabel} exited ${code}`)));
    proc.on('error', reject);
  });
}

function parseXmlVersions(xmlText) {
  return [...String(xmlText).matchAll(/<version>([^<]+)<\/version>/g)].map(match => match[1]);
}

// --- Properties ---------------------------------------------------------------
function readProperties() {
  const file = path.join(CONFIG.serverDir, 'server.properties');
  if (!fs.existsSync(file)) return {};
  const props = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    const [k, ...v] = line.split('=');
    props[k.trim()] = v.join('=').trim();
  }
  return props;
}

function writeProperties(props) {
  const file = path.join(CONFIG.serverDir, 'server.properties');
  let existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const written = new Set();
  const updated = existing.split('\n').map(line => {
    if (line.startsWith('#') || !line.includes('=')) return line;
    const key = line.split('=')[0].trim();
    if (props[key] !== undefined) { written.add(key); return `${key}=${props[key]}`; }
    return line;
  });
  for (const [k, v] of Object.entries(props)) if (!written.has(k)) updated.push(`${k}=${v}`);
  fs.mkdirSync(CONFIG.serverDir, { recursive: true });
  fs.writeFileSync(file, updated.join('\n'));
}

// --- Routes -------------------------------------------------------------------
app.use(express.json());

app.get('/api/status', (_, res) => res.json({
  running: !!mcProcess, config: CONFIG, uptime: getUptime(),
  players: Object.values(onlinePlayers),
  jarExists: fs.existsSync(path.join(CONFIG.serverDir, CONFIG.serverJar)),
  download: downloadState,
  network: getNetworkInfo(),
}));

app.post('/api/start', (_, res) => {
  if (mcProcess) return res.json({ error: 'Already running' });
  const jar = path.join(CONFIG.serverDir, CONFIG.serverJar);
  if (!fs.existsSync(jar)) return res.json({ error: `${CONFIG.serverJar} not found in ${CONFIG.serverDir}` });

  const eula = path.join(CONFIG.serverDir, 'eula.txt');
  if (!fs.existsSync(eula)) fs.writeFileSync(eula, 'eula=true\n');

  mcProcess = spawn(CONFIG.javaPath, [
    `-Xmx${CONFIG.memory}`, `-Xms${CONFIG.memory}`, '-jar', CONFIG.serverJar, 'nogui'
  ], { cwd: CONFIG.serverDir, stdio: ['pipe','pipe','pipe'] });

  mcProcess.stdout.on('data', d => String(d).split('\n').forEach(l => addLog(l, 'log')));
  mcProcess.stderr.on('data', d => String(d).split('\n').forEach(l => addLog(l, 'warn')));
  mcProcess.on('error', err => addLog(`Process error: ${err.message}`, 'error'));
  mcProcess.on('exit', code => {
    addLog(`--- Server stopped (exit ${code ?? 'signal'}) ---`, 'system');
    if (pidusage) { try { pidusage.clear(); } catch(e) {} }
    mcProcess = null; onlinePlayers = {}; startTime = null;
    updateSystemStats();
    broadcast({ type: 'status', running: false, players: [], uptime: null });
  });

  startTime = Date.now();
  addLog(`--- Starting ${CONFIG.serverJar} (${CONFIG.memory} RAM) ---`, 'system');
  broadcast({ type: 'status', running: true });
  res.json({ ok: true });
});

app.post('/api/stop', (_, res) => {
  if (!mcProcess) return res.json({ error: 'Not running' });
  mcProcess.stdin.write('stop\n');
  addLog('--- Stop command sent ---', 'system');
  res.json({ ok: true });
});

app.post('/api/restart', (_, res) => {
  const jar = path.join(CONFIG.serverDir, CONFIG.serverJar);
  if (!fs.existsSync(jar)) {
    return res.json({ error: `${CONFIG.serverJar} not found in ${CONFIG.serverDir}` });
  }

  if (!mcProcess) {
    return res.json({ error: 'Not running' });
  }

  let restarted = false;
  mcProcess.once('exit', () => {
    if (restarted) return;
    restarted = true;

    const eula = path.join(CONFIG.serverDir, 'eula.txt');
    if (!fs.existsSync(eula)) fs.writeFileSync(eula, 'eula=true\n');

    mcProcess = spawn(CONFIG.javaPath, [
      `-Xmx${CONFIG.memory}`, `-Xms${CONFIG.memory}`, '-jar', CONFIG.serverJar, 'nogui'
    ], { cwd: CONFIG.serverDir, stdio: ['pipe','pipe','pipe'] });

    mcProcess.stdout.on('data', d => String(d).split('\n').forEach(l => addLog(l, 'log')));
    mcProcess.stderr.on('data', d => String(d).split('\n').forEach(l => addLog(l, 'warn')));
    mcProcess.on('error', err => addLog(`Process error: ${err.message}`, 'error'));
    mcProcess.on('exit', code => {
      addLog(`--- Server stopped (exit ${code ?? 'signal'}) ---`, 'system');
      if (pidusage) { try { pidusage.clear(); } catch(e) {} }
      mcProcess = null; onlinePlayers = {}; startTime = null;
      updateSystemStats();
      broadcast({ type: 'status', running: false, players: [], uptime: null });
    });

    startTime = Date.now();
    addLog(`--- Restarting ${CONFIG.serverJar} (${CONFIG.memory} RAM) ---`, 'system');
    broadcast({ type: 'status', running: true });
  });

  mcProcess.stdin.write('stop\n');
  addLog('--- Restart command sent ---', 'system');
  res.json({ ok: true });
});

app.post('/api/kill', (_, res) => {
  if (!mcProcess) return res.json({ error: 'Not running' });
  mcProcess.kill('SIGKILL');
  addLog('--- Force killed ---', 'error');
  res.json({ ok: true });
});

app.post('/api/command', (req, res) => {
  const cmd = (req.body?.command || '').trim();
  if (!cmd) return res.json({ error: 'Empty' });
  if (!mcProcess) return res.json({ error: 'Not running' });
  mcProcess.stdin.write(cmd + '\n');
  addLog(`> ${cmd}`, 'cmd');
  res.json({ ok: true });
});

app.post('/api/player/:action', (req, res) => {
  const { name, extra } = req.body;
  if (!mcProcess) return res.json({ error: 'Not running' });
  const map = {
    kick: `kick ${name} ${extra||'Kicked by admin'}`,
    ban: `ban ${name} ${extra||'Banned by admin'}`,
    unban: `pardon ${name}`,
    op: `op ${name}`, deop: `deop ${name}`,
    survival: `gamemode survival ${name}`,
    creative: `gamemode creative ${name}`,
    spectator: `gamemode spectator ${name}`,
    adventure: `gamemode adventure ${name}`,
    tp: extra ? `tp ${name} ${extra}` : null,
    heal: `effect give ${name} minecraft:instant_health 1 255`,
    feed: `effect give ${name} minecraft:saturation 1 255`,
    kill: `kill ${name}`,
    invsee: `invsee ${name}`,
  };
  const cmd = map[req.params.action];
  if (!cmd) return res.json({ error: req.params.action === 'tp' ? 'tp requires a destination' : 'Unknown action' });
  mcProcess.stdin.write(cmd + '\n');
  addLog(`> ${cmd}`, 'cmd');
  res.json({ ok: true });
});

app.post('/api/list', (_, res) => {
  if (mcProcess) mcProcess.stdin.write('list\n');
  res.json({ ok: true });
});

app.get('/api/config', (_, res) => res.json(CONFIG));
app.post('/api/config', (req, res) => {
  const { memory, serverDir, serverJar, javaPath } = req.body;
  if (memory)    CONFIG.memory    = memory;
  if (serverDir) CONFIG.serverDir = serverDir;
  if (serverJar) CONFIG.serverJar = serverJar;
  if (javaPath)  CONFIG.javaPath  = javaPath;
  saveConfig();
  updateSystemStats();
  res.json({ ok: true, config: CONFIG });
});

app.get('/api/properties', (_, res) => res.json(readProperties()));
app.post('/api/properties', (req, res) => {
  try { writeProperties(req.body); res.json({ ok: true }); }
  catch (e) { res.json({ error: e.message }); }
});

app.get('/api/plugins', (_, res) => {
  const dir = path.join(CONFIG.serverDir, 'plugins');
  if (!fs.existsSync(dir)) return res.json({ plugins: [] });
  const plugins = fs.readdirSync(dir).filter(f => f.endsWith('.jar')).map(f => {
    const stat = fs.statSync(path.join(dir, f));
    return { name: f, size: stat.size };
  });
  res.json({ plugins });
});

app.get('/api/mods', (_, res) => {
  const dir = path.join(CONFIG.serverDir, 'mods');
  if (!fs.existsSync(dir)) return res.json({ mods: [] });
  const mods = fs.readdirSync(dir).filter(f => f.endsWith('.jar')).map(f => {
    const stat = fs.statSync(path.join(dir, f));
    return { name: f, size: stat.size };
  });
  res.json({ mods });
});

app.post('/api/mods/upload', (req, res) => {
  const { filename, data } = req.body;
  if (!filename || !data) return res.json({ error: 'Missing filename or data' });
  if (!filename.endsWith('.jar')) return res.json({ error: 'Only .jar files allowed' });
  
  const modsDir = path.join(CONFIG.serverDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  
  const filePath = path.join(modsDir, path.basename(filename));
  if (fs.existsSync(filePath)) return res.json({ error: 'File already exists' });
  
  try {
    const buffer = Buffer.from(data, 'base64');
    fs.writeFileSync(filePath, buffer);
    res.json({ ok: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.delete('/api/mods/:name', (req, res) => {
  const file = path.join(CONFIG.serverDir, 'mods', path.basename(req.params.name));
  if (!fs.existsSync(file)) return res.json({ error: 'Not found' });
  fs.unlinkSync(file);
  res.json({ ok: true });
});

app.post('/api/plugins/upload', (req, res) => {
  const { filename, data } = req.body;
  if (!filename || !data) return res.json({ error: 'Missing filename or data' });
  if (!filename.endsWith('.jar')) return res.json({ error: 'Only .jar files allowed' });
  const plgDir = path.join(CONFIG.serverDir, 'plugins');
  fs.mkdirSync(plgDir, { recursive: true });
  const filePath = path.join(plgDir, path.basename(filename));
  if (fs.existsSync(filePath)) return res.json({ error: 'File already exists' });
  try { fs.writeFileSync(filePath, Buffer.from(data, 'base64')); res.json({ ok: true }); }
  catch (e) { res.json({ error: e.message }); }
});

app.delete('/api/plugins/:name', (req, res) => {
  const file = path.join(CONFIG.serverDir, 'plugins', path.basename(req.params.name));
  if (!fs.existsSync(file)) return res.json({ error: 'Not found' });
  fs.unlinkSync(file);
  res.json({ ok: true });
});

app.get('/api/versions/paper', async (_, res) => {
  try {
    const d = await httpsGet('https://api.papermc.io/v2/projects/paper');
    res.json({ versions: [...d.versions].reverse() });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/versions/vanilla', async (_, res) => {
  try {
    const m = await httpsGet('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    const releases = m.versions.filter(v => v.type === 'release');
    res.json({ versions: releases.map(v => v.id), urls: Object.fromEntries(releases.map(v => [v.id, v.url])) });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/versions/fabric', async (_, res) => {
  try {
    const m = await httpsGet('https://meta.fabricmc.net/v2/versions/game');
    const releases = m.filter(v => v.stable).map(v => v.version);
    res.json({ versions: releases });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/versions/forge', async (_, res) => {
  try {
    const data = await httpsGet('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    // data.promos is an object like { "1.21.1-latest": "forge-ver", "1.21.1-recommended": "forge-ver" }
    const promos = data.promos || {};
    // Build list: "MC-forgeVer" for recommended versions, newest MC first
    const seen = new Set();
    const versions = [];
    for (const [key, forgeVer] of Object.entries(promos)) {
      const match = key.match(/^(.+)-(latest|recommended)$/);
      if (!match) continue;
      const mcVer = match[1];
      const label = `${mcVer} - ${forgeVer} (${match[2]})`;
      if (!seen.has(mcVer+forgeVer)) { seen.add(mcVer+forgeVer); versions.push(label); }
    }
    versions.reverse(); // newest first
    res.json({ versions });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/versions/neoforge', async (_, res) => {
  try {
    const xml = await httpsGet('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
    const versions = parseXmlVersions(xml);
    const stableVersions = versions.filter(version => !/(alpha|beta|snapshot)/i.test(version));
    res.json({ versions: (stableVersions.length ? stableVersions : versions).reverse() });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/versions/quilt', async (_, res) => {
  try {
    const m = await httpsGet('https://meta.quiltmc.org/v3/versions/game');
    const releases = m.filter(v => v.stable).map(v => v.version);
    res.json({ versions: releases });
  } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/download', async (req, res) => {
  if (downloadState && !downloadState.done && !downloadState.error)
    return res.json({ error: 'Download already in progress' });

  const { type, version } = req.body;
  res.json({ ok: true });

  downloadState = { name: `${type}-${version}.jar`, progress: 0, total: 0, done: false, error: null };
  broadcast({ type: 'download', ...downloadState });

  try {
    fs.mkdirSync(CONFIG.serverDir, { recursive: true });
    const outPath = path.join(CONFIG.serverDir, 'server.jar');
    let downloadUrl;

    if (type === 'paper') {
      const builds = await httpsGet(`https://api.papermc.io/v2/projects/paper/versions/${version}`);
      const build  = Math.max(...builds.builds);
      downloadUrl  = `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${build}/downloads/paper-${version}-${build}.jar`;
    } else if (type === 'fabric') {
      const loaders    = await httpsGet('https://meta.fabricmc.net/v2/versions/loader');
      const installers = await httpsGet('https://meta.fabricmc.net/v2/versions/installer');
      const loaderVer  = loaders[0].version;
      const instVer    = installers[0].version;
      const instUrl    = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${instVer}/fabric-installer-${instVer}.jar`;
      const instPath   = path.join(CONFIG.serverDir, `fabric-installer-${instVer}.jar`);

      addLog('--- Downloading Fabric installer... ---', 'system');
      await downloadFileWithProgress(instUrl, instPath);

      addLog('--- Running Fabric installer (this also downloads MC, may take a while)... ---', 'system');
      downloadState.name = `fabric-${version} (installing...)`;
      broadcast({ type: 'download', ...downloadState });

      await runLoggedProcess(
        CONFIG.javaPath,
        ['-jar', instPath, 'server', '-mcversion', version, '-loader', loaderVer, '-downloadMinecraft'],
        CONFIG.serverDir,
        'Fabric installer'
      );

      try { fs.unlinkSync(instPath); } catch {}
      const fabricLaunch = path.join(CONFIG.serverDir, 'fabric-server-launch.jar');
      if (!fs.existsSync(fabricLaunch)) throw new Error('Fabric installer ran but fabric-server-launch.jar not found');

      CONFIG.serverJar = 'fabric-server-launch.jar';
      CONFIG.serverType = 'fabric';
      CONFIG.serverVersion = version;
      saveConfig();
      fs.writeFileSync(path.join(CONFIG.serverDir, 'eula.txt'), 'eula=true\n');
      addLog(`--- Fabric ${version} ready ? fabric-server-launch.jar ---`, 'system');
      downloadState.done = true;
      broadcast({ type: 'download', ...downloadState });
      broadcast({ type: 'jarReady' });
      broadcast({ type: 'config', config: CONFIG });
      return;
    } else if (type === 'quilt') {
      const installers = await httpsGet('https://meta.quiltmc.org/v3/versions/installer');
      const loaders = await httpsGet('https://meta.quiltmc.org/v3/versions/loader');
      const installer = installers[0];
      const loader = loaders.find(v => !/(alpha|beta)/i.test(v.version)) || loaders[0];
      const instPath = path.join(CONFIG.serverDir, `quilt-installer-${installer.version}.jar`);

      addLog('--- Downloading Quilt installer... ---', 'system');
      await downloadFileWithProgress(installer.url, instPath);

      addLog('--- Running Quilt installer (this also downloads MC, may take a while)... ---', 'system');
      downloadState.name = `quilt-${version} (installing...)`;
      broadcast({ type: 'download', ...downloadState });

      await runLoggedProcess(
        CONFIG.javaPath,
        [
          '-jar',
          instPath,
          'install',
          'server',
          version,
          loader.version,
          `--install-dir="${CONFIG.serverDir}"`,
          '--download-server',
        ],
        CONFIG.serverDir,
        'Quilt installer'
      );

      try { fs.unlinkSync(instPath); } catch {}
      const quiltLaunch = path.join(CONFIG.serverDir, 'quilt-server-launch.jar');
      if (!fs.existsSync(quiltLaunch)) throw new Error('Quilt installer ran but quilt-server-launch.jar not found');

      CONFIG.serverJar = 'quilt-server-launch.jar';
      CONFIG.serverType = 'quilt';
      CONFIG.serverVersion = version;
      saveConfig();
      fs.writeFileSync(path.join(CONFIG.serverDir, 'eula.txt'), 'eula=true\n');
      addLog(`--- Quilt ${version} ready --- using quilt-server-launch.jar ---`, 'system');
      downloadState.done = true;
      broadcast({ type: 'download', ...downloadState });
      broadcast({ type: 'jarReady' });
      broadcast({ type: 'config', config: CONFIG });
      return;
    } else if (type === 'forge') {
      // version string is like "1.21.1 - 47.3.0 (recommended)"
      const mcVerMatch = version.match(/^([0-9.]+)/);
      const forgeVerMatch = version.match(/- ([0-9.]+)/);
      if (!mcVerMatch || !forgeVerMatch) throw new Error('Could not parse Forge version string');
      const mcVer = mcVerMatch[1];
      const forgeVer = forgeVerMatch[1];
      const forgeInstallerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVer}-${forgeVer}/forge-${mcVer}-${forgeVer}-installer.jar`;
      const instPath = path.join(CONFIG.serverDir, `forge-${mcVer}-${forgeVer}-installer.jar`);

      addLog(`--- Downloading Forge ${mcVer}-${forgeVer} installer... ---`, 'system');
      await downloadFileWithProgress(forgeInstallerUrl, instPath);

      addLog('--- Running Forge installer (this downloads MC libraries, may take a while)... ---', 'system');
      downloadState.name = `forge-${mcVer}-${forgeVer} (installing...)`;
      broadcast({ type: 'download', ...downloadState });

      await runLoggedProcess(
        CONFIG.javaPath,
        ['-jar', instPath, '--installServer'],
        CONFIG.serverDir,
        'Forge installer'
      );

      try { fs.unlinkSync(instPath); } catch {}
      // Forge creates a run.sh or @libraries/net/... shim — use the shim jar
      const shimJar = `forge-${mcVer}-${forgeVer}-shim.jar`;
      const shimPath = path.join(CONFIG.serverDir, shimJar);
      const userdevJar = `forge-${mcVer}-${forgeVer}.jar`;
      const jarToUse = fs.existsSync(shimPath) ? shimJar : (fs.existsSync(path.join(CONFIG.serverDir, userdevJar)) ? userdevJar : null);
      if (!jarToUse) throw new Error('Forge installed but could not find server jar. Check the server directory for a run.sh or @server.args file.');

      CONFIG.serverJar = jarToUse;
      CONFIG.serverType = 'forge';
      CONFIG.serverVersion = `${mcVer}-${forgeVer}`;
      saveConfig();
      fs.writeFileSync(path.join(CONFIG.serverDir, 'eula.txt'), 'eula=true\n');
      addLog(`--- Forge ${mcVer}-${forgeVer} ready --- using ${jarToUse} ---`, 'system');
      downloadState.done = true;
      broadcast({ type: 'download', ...downloadState });
      broadcast({ type: 'jarReady' });
      broadcast({ type: 'config', config: CONFIG });
      return;
    } else if (type === 'neoforge') {
      const neoInstallerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
      const instPath = path.join(CONFIG.serverDir, `neoforge-${version}-installer.jar`);

      addLog(`--- Downloading NeoForge ${version} installer... ---`, 'system');
      await downloadFileWithProgress(neoInstallerUrl, instPath);

      addLog('--- Running NeoForge installer (this downloads MC libraries, may take a while)... ---', 'system');
      downloadState.name = `neoforge-${version} (installing...)`;
      broadcast({ type: 'download', ...downloadState });

      await runLoggedProcess(
        CONFIG.javaPath,
        ['-jar', instPath, '--installServer', '.', '--serverJar'],
        CONFIG.serverDir,
        'NeoForge installer'
      );

      try { fs.unlinkSync(instPath); } catch {}
      const neoServerJar = ['server.jar', `neoforge-${version}-server.jar`]
        .find(file => fs.existsSync(path.join(CONFIG.serverDir, file)));
      if (!neoServerJar) throw new Error('NeoForge installed but no server starter jar was found');

      CONFIG.serverJar = neoServerJar;
      CONFIG.serverType = 'neoforge';
      CONFIG.serverVersion = version;
      saveConfig();
      fs.writeFileSync(path.join(CONFIG.serverDir, 'eula.txt'), 'eula=true\n');
      addLog(`--- NeoForge ${version} ready --- using ${neoServerJar} ---`, 'system');
      downloadState.done = true;
      broadcast({ type: 'download', ...downloadState });
      broadcast({ type: 'jarReady' });
      broadcast({ type: 'config', config: CONFIG });
      return;
    } else {
      const m   = await httpsGet('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
      const v   = m.versions.find(x => x.id === version);
      if (!v) throw new Error('Version not found');
      const vj  = await httpsGet(v.url);
      downloadUrl = vj.downloads.server.url;
    }

    await new Promise((resolve, reject) => {
      const doGet = (url, depth = 0) => {
        if (depth > 5) return reject(new Error('Too many redirects'));
        const mod = url.startsWith('https') ? https : http;
        mod.get(url, { headers: { 'User-Agent': 'DroidMC/2.0' } }, response => {
          if (response.statusCode >= 300 && response.headers.location)
            return doGet(response.headers.location, depth + 1);
          if (response.statusCode !== 200)
            return reject(new Error(`HTTP ${response.statusCode}`));

          downloadState.total = parseInt(response.headers['content-length'] || '0');
          let received = 0;
          const out = fs.createWriteStream(outPath);
          response.on('data', chunk => {
            received += chunk.length;
            downloadState.progress = received;
            broadcast({ type: 'download', ...downloadState });
          });
          response.pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
          response.on('error', reject);
        }).on('error', reject);
      };
      doGet(downloadUrl);
    });

    CONFIG.serverType = type;
    CONFIG.serverVersion = version;
    saveConfig();
    fs.writeFileSync(path.join(CONFIG.serverDir, 'eula.txt'), 'eula=true\n');
    addLog(`--- Downloaded ${type} ${version} ? server.jar ---`, 'system');
    downloadState.done = true;
    broadcast({ type: 'download', ...downloadState });
    broadcast({ type: 'jarReady' });
  } catch (e) {
    downloadState.error = e.message;
    addLog(`Download error: ${e.message}`, 'error');
    broadcast({ type: 'download', ...downloadState });
  }
});

// --- WebSocket ----------------------------------------------------------------
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'history', logs: logHistory }));
  ws.send(JSON.stringify({ type: 'status', running: !!mcProcess, players: Object.values(onlinePlayers), uptime: getUptime() }));
  ws.send(JSON.stringify({ type: 'config', config: CONFIG }));
  ws.send(JSON.stringify({ type: 'stats', ...systemStats }));
  if (downloadState) ws.send(JSON.stringify({ type: 'download', ...downloadState }));

  const tick = setInterval(() => {
    if (ws.readyState === 1 && mcProcess)
      ws.send(JSON.stringify({ type: 'uptime', uptime: getUptime() }));
  }, 1000);
  ws.on('close', () => clearInterval(tick));
});

// --- Launch -------------------------------------------------------------------
updateSystemStats();
setInterval(updateSystemStats, 1000);

server.listen(CONFIG.uiPort, '0.0.0.0', () => {
  const network = getNetworkInfo();
  console.log(`\n  DroidMC panel: http://localhost:${CONFIG.uiPort}`);
  console.log(`  LAN address:   http://${network.lanIp}:${CONFIG.uiPort}\n`);
});

// --- HTML ---------------------------------------------------------------------

// --- Static files -------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
