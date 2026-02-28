#!/usr/bin/env node
/**
 * MC Control v2 — Full Minecraft Server Panel for Termux
 * Like Aternos, but on your phone. http://localhost:8080
 */

const express  = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ─── State ────────────────────────────────────────────────────────────────────
let mcProcess     = null;
let logHistory    = [];
let onlinePlayers = {};   // name → { name, joined }
let startTime     = null;
let downloadState = null;
let systemStats   = { cpu: 0, ram: 0 };

const CONFIG_FILE = path.join(process.env.HOME || '/data/data/com.termux/files/home', 'mc-control', 'config.json');
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

// ─── Verbose terminal logging ─────────────────────────────────────────────────
const VERBOSE = process.env.MC_VERBOSE === '1';
const ANSI = { reset:'\x1b[0m', dim:'\x1b[2m', green:'\x1b[32m', amber:'\x1b[33m', red:'\x1b[31m', blue:'\x1b[34m' };
function verbosePrint(text, type) {
  if (!VERBOSE) return;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const col = type==='warn'?ANSI.amber:type==='error'?ANSI.red:type==='system'?ANSI.green:type==='cmd'?ANSI.blue:ANSI.reset;
  process.stdout.write(`${ANSI.dim}${time}${ANSI.reset} ${col}${text}${ANSI.reset}\n`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

let _prevCpu = null;
function updateSystemStats() {
  const totMem = os.totalmem(), freeMem = os.freemem();
  const cpus = os.cpus();
  let idle = 0, total = 0;
  cpus.forEach(cpu => { for (const t in cpu.times) total += cpu.times[t]; idle += cpu.times.idle; });
  let cpuUsage = 0;
  if (_prevCpu) {
    const dIdle = idle - _prevCpu.idle, dTotal = total - _prevCpu.total;
    cpuUsage = dTotal > 0 ? Math.round(100 * (1 - dIdle / dTotal)) : 0;
  }
  _prevCpu = { idle, total };
  systemStats = { cpu: cpuUsage, ram: Math.round((totMem - freeMem) / totMem * 100) };
  broadcast({ type: 'stats', cpu: systemStats.cpu, ram: systemStats.ram });
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

function httpsGet(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'MC-Control/2.0 (termux-panel)' } }, res => {
      if (res.statusCode >= 300 && res.headers.location)
        return httpsGet(res.headers.location, depth + 1).then(resolve).catch(reject);
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    }).on('error', reject);
  });
}

// ─── Properties ───────────────────────────────────────────────────────────────
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

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use(express.json());

app.get('/api/status', (_, res) => res.json({
  running: !!mcProcess, config: CONFIG, uptime: getUptime(),
  players: Object.values(onlinePlayers),
  jarExists: fs.existsSync(path.join(CONFIG.serverDir, CONFIG.serverJar)),
  download: downloadState,
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
    addLog(`─── Server stopped (exit ${code ?? 'signal'}) ───`, 'system');
    mcProcess = null; onlinePlayers = {}; startTime = null;
    broadcast({ type: 'status', running: false, players: [], uptime: null });
  });

  startTime = Date.now();
  addLog(`─── Starting ${CONFIG.serverJar} (${CONFIG.memory} RAM) ───`, 'system');
  broadcast({ type: 'status', running: true });
  res.json({ ok: true });
});

app.post('/api/stop', (_, res) => {
  if (!mcProcess) return res.json({ error: 'Not running' });
  mcProcess.stdin.write('stop\n');
  addLog('─── Stop command sent ───', 'system');
  res.json({ ok: true });
});

app.post('/api/kill', (_, res) => {
  if (!mcProcess) return res.json({ error: 'Not running' });
  mcProcess.kill('SIGKILL');
  addLog('─── Force killed ───', 'error');
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

      addLog('─── Downloading Fabric installer... ───', 'system');
      await new Promise((resolve, reject) => {
        const doGetInst = (url, depth = 0) => {
          if (depth > 5) return reject(new Error('Too many redirects'));
          const mod = url.startsWith('https') ? https : http;
          mod.get(url, { headers: { 'User-Agent': 'MC-Control/2.0' } }, response => {
            if (response.statusCode >= 300 && response.headers.location) return doGetInst(response.headers.location, depth + 1);
            if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
            downloadState.total = parseInt(response.headers['content-length'] || '0');
            let received = 0;
            const out = fs.createWriteStream(instPath);
            response.on('data', chunk => { received += chunk.length; downloadState.progress = received; broadcast({ type: 'download', ...downloadState }); });
            response.pipe(out);
            out.on('finish', resolve); out.on('error', reject); response.on('error', reject);
          }).on('error', reject);
        };
        doGetInst(instUrl);
      });

      addLog('─── Running Fabric installer (this also downloads MC, may take a while)... ───', 'system');
      downloadState.name = `fabric-${version} (installing...)`;
      broadcast({ type: 'download', ...downloadState });

      await new Promise((resolve, reject) => {
        const inst = spawn(CONFIG.javaPath, [
          '-jar', instPath, 'server', '-mcversion', version, '-loader', loaderVer, '-downloadMinecraft'
        ], { cwd: CONFIG.serverDir });
        inst.stdout.on('data', d => String(d).split('\n').forEach(l => { if (l.trim()) addLog(l.trim(), 'system'); }));
        inst.stderr.on('data', d => String(d).split('\n').forEach(l => { if (l.trim()) addLog(l.trim(), 'warn'); }));
        inst.on('exit', code => code === 0 ? resolve() : reject(new Error(`Fabric installer exited ${code}`)));
        inst.on('error', reject);
      });

      try { fs.unlinkSync(instPath); } catch {}
      const fabricLaunch = path.join(CONFIG.serverDir, 'fabric-server-launch.jar');
      if (!fs.existsSync(fabricLaunch)) throw new Error('Fabric installer ran but fabric-server-launch.jar not found');

      CONFIG.serverJar = 'fabric-server-launch.jar';
      CONFIG.serverType = 'fabric';
      CONFIG.serverVersion = version;
      saveConfig();
      fs.writeFileSync(path.join(CONFIG.serverDir, 'eula.txt'), 'eula=true\n');
      addLog(`─── Fabric ${version} ready → fabric-server-launch.jar ───`, 'system');
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
        mod.get(url, { headers: { 'User-Agent': 'MC-Control/2.0' } }, response => {
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
    addLog(`─── Downloaded ${type} ${version} → server.jar ───`, 'system');
    downloadState.done = true;
    broadcast({ type: 'download', ...downloadState });
    broadcast({ type: 'jarReady' });
  } catch (e) {
    downloadState.error = e.message;
    addLog(`Download error: ${e.message}`, 'error');
    broadcast({ type: 'download', ...downloadState });
  }
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
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

// ─── Launch ───────────────────────────────────────────────────────────────────
setInterval(updateSystemStats, 1000);

server.listen(CONFIG.uiPort, '0.0.0.0', () => {
  console.log(`\n  ⬛ MC Control v2  →  http://localhost:${CONFIG.uiPort}\n`);
});

// ─── HTML ─────────────────────────────────────────────────────────────────────
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>MC Control</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#090d13;--panel:#0f1520;--panel2:#141c28;--panel3:#1a2336;
  --border:#1d2d3e;--blight:#253448;
  --green:#3fb950;--gdim:#238636;--gglow:rgba(63,185,80,.1);--gglowb:rgba(63,185,80,.2);
  --amber:#e3b341;--red:#f85149;--blue:#58a6ff;--purple:#bc8cff;
  --t:#e6edf3;--td:#7d8a99;--tm:#243040;
  --mono:'IBM Plex Mono',monospace;--sans:'Outfit',sans-serif;
  --r:10px;--shadow:0 8px 32px rgba(0,0,0,.5);
}
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden}
body{background:var(--bg);color:var(--t);font-family:var(--sans);display:flex;flex-direction:column}

/* ─ topbar ─ */
.topbar{
  height:50px;background:var(--panel);border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;padding:0 16px;flex-shrink:0;
  position:relative;z-index:10;
}
.logo{font-family:var(--mono);font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;letter-spacing:.02em;user-select:none}
.logo-em{color:var(--green)}
.logo-cube{width:16px;height:16px;background:linear-gradient(145deg,#5cb85c,#2d7a2d);border-radius:3px;border-bottom:2px solid #1a4a1a;flex-shrink:0;display:inline-block}
.logo-by{font-size:9px;color:rgba(255,255,255,.32);font-weight:400;text-decoration:none;margin-left:4px;letter-spacing:.02em;transition:color .2s;white-space:nowrap}
.logo-by:hover{color:var(--green)}
.topright{display:flex;align-items:center;gap:7px}
.tstat{
  display:flex;align-items:center;gap:5px;padding:4px 9px;
  background:var(--panel2);border:1px solid var(--border);border-radius:7px;
  font-family:var(--mono);font-size:10px;color:var(--td);
}
.tstat .v{color:var(--t);font-weight:600}.tstat .g{color:var(--green);font-weight:600}

.pill{
  display:flex;align-items:center;gap:6px;padding:5px 12px;
  background:var(--panel2);border:1px solid var(--border);border-radius:99px;
  font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.07em;transition:.35s;
}
.pill.on{border-color:var(--gdim);color:var(--green);background:var(--gglow);box-shadow:0 0 16px rgba(63,185,80,.15)}
.pill.off{color:var(--td)}
.dot{width:6px;height:6px;border-radius:50%;background:var(--tm);transition:.35s;flex-shrink:0}
.pill.on .dot{background:var(--green);box-shadow:0 0 8px var(--green);animation:pulse 2.2s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.75)}}

/* ─ layout ─ */
.layout{display:flex;flex:1;overflow:hidden}

/* ─ sidebar ─ */
.sidebar{
  width:64px;background:var(--panel);border-right:1px solid var(--border);
  display:flex;flex-direction:column;align-items:center;padding:8px 0;gap:1px;flex-shrink:0;
}
.nb{
  width:48px;min-height:48px;border:none;background:transparent;color:var(--td);
  border-radius:10px;cursor:pointer;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:3px;font-size:17px;transition:.15s;position:relative;
  border:1px solid transparent;
}
.nb:hover{background:var(--panel2);color:var(--t);border-color:var(--border)}
.nb.active{background:var(--gglow);color:var(--green);border-color:var(--gdim)}
.nb .nl{font-family:var(--mono);font-size:7px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;line-height:1;opacity:.8}
.nb.active .nl{opacity:1}
.nb .bdg{
  position:absolute;top:5px;right:5px;background:var(--green);color:#000;
  font-family:var(--mono);font-size:7px;font-weight:700;min-width:12px;height:12px;
  border-radius:99px;display:flex;align-items:center;justify-content:center;padding:0 2px;
}
.nsep{width:30px;height:1px;background:var(--border);margin:4px 0;flex-shrink:0}
.nb-bot{margin-top:auto}

/* ─ main ─ */
.main{flex:1;overflow:hidden;display:flex;flex-direction:column}
.tab{display:none;flex:1;overflow:hidden;flex-direction:column}
.tab.active{display:flex;animation:fadein .18s ease}
@keyframes fadein{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.tcontent{flex:1;overflow-y:auto;padding:14px 16px 24px}
.tcontent::-webkit-scrollbar{width:3px}
.tcontent::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}

/* ─ buttons ─ */
.btn{
  padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:var(--panel2);
  color:var(--t);font-family:var(--sans);font-size:13px;font-weight:600;cursor:pointer;
  transition:.15s;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;
}
.btn:hover{background:var(--panel3);border-color:var(--blight)}
.btn:active{transform:scale(.97)}
.btn:disabled{opacity:.28;cursor:not-allowed;transform:none!important}
.bg{background:var(--gglow);border-color:var(--gdim);color:var(--green)}
.bg:hover:not(:disabled){background:var(--gglowb);border-color:var(--green)}
.br{background:rgba(248,81,73,.07);border-color:rgba(248,81,73,.28);color:var(--red)}
.br:hover:not(:disabled){background:rgba(248,81,73,.15)}
.bb{background:rgba(88,166,255,.07);border-color:rgba(88,166,255,.28);color:var(--blue)}
.bb:hover:not(:disabled){background:rgba(88,166,255,.15)}
.ba{background:rgba(227,179,65,.07);border-color:rgba(227,179,65,.28);color:var(--amber)}
.ba:hover:not(:disabled){background:rgba(227,179,65,.15)}
.sm{padding:5px 11px;font-size:12px;border-radius:7px}
.xs{padding:3px 8px;font-size:11px;border-radius:6px}
.full{width:100%;justify-content:center}

/* ─ inputs ─ */
.inp{
  width:100%;background:var(--panel2);border:1px solid var(--border);border-radius:8px;
  color:var(--t);font-family:var(--mono);font-size:13px;padding:9px 12px;transition:.15s;
}
.inp:focus{outline:none;border-color:var(--gdim);background:var(--panel3)}
select.inp{appearance:none;cursor:pointer}

/* ─ cards ─ */
.card{
  background:var(--panel);border:1px solid var(--border);border-radius:12px;
  padding:14px;margin-bottom:10px;
}
.ctitle{
  font-size:10px;font-family:var(--mono);color:var(--td);text-transform:uppercase;
  letter-spacing:.13em;margin-bottom:12px;font-weight:600;
}

/* ─ dashboard ─ */
.status-hero{
  background:var(--panel);border:1px solid var(--border);border-radius:14px;
  padding:16px;margin-bottom:10px;transition:.4s;position:relative;overflow:hidden;
}
.status-hero.online{border-color:var(--gdim);box-shadow:0 0 24px rgba(63,185,80,.1),inset 0 1px 0 rgba(63,185,80,.1)}
.status-hero.online::before{
  content:'';position:absolute;top:0;left:0;right:0;height:2px;
  background:linear-gradient(90deg,transparent 0%,var(--gdim) 30%,var(--green) 50%,var(--gdim) 70%,transparent 100%);
}
.sh-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px;gap:10px}
.sh-title{font-size:14px;font-weight:700;letter-spacing:.01em}
.sh-sub{font-size:12px;color:var(--td);font-family:var(--mono);margin-top:4px;font-weight:600}
.sh-sub.online{color:var(--green)}
.sh-btns{display:flex;gap:6px;flex-shrink:0}

.sgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
.sbox{
  background:var(--panel);border:1px solid var(--border);border-radius:12px;
  padding:12px 14px;display:flex;align-items:center;gap:12px;transition:.2s;
}
.sbox:hover{border-color:var(--blight)}

/* ring gauges */
.gauge-wrap{position:relative;width:52px;height:52px;flex-shrink:0}
.gauge{width:52px;height:52px;transform:rotate(-90deg);position:absolute;top:0;left:0}
.gauge-bg{fill:none;stroke:var(--border);stroke-width:5}
.gauge-fill{fill:none;stroke:var(--green);stroke-width:5;stroke-linecap:round;stroke-dasharray:0 132;transition:stroke-dasharray .65s ease,stroke .3s}
.gauge-fill.warn{stroke:var(--amber)}
.gauge-fill.crit{stroke:var(--red)}
.gauge-pct{
  position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-family:var(--mono);font-size:10px;font-weight:700;color:var(--td);
}
.sbox-info{flex:1;min-width:0}
.slabel{font-size:9px;font-family:var(--mono);color:var(--td);text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px;font-weight:600}
.sval{font-family:var(--mono);font-size:22px;font-weight:700;color:var(--green);line-height:1}
.sval.dim{color:var(--tm);font-size:15px}
.sval.sm2{font-size:18px;color:var(--t)}
.sbox-icon{font-size:28px;flex-shrink:0;opacity:.8}
.qgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.ci-grid{display:flex;flex-direction:column;gap:0}
.ci-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)}
.ci-row:last-child{border-bottom:none;padding-bottom:0}
.ci-lbl{font-size:11px;font-family:var(--mono);color:var(--td);width:100px;flex-shrink:0}
.ci-val{font-family:var(--mono);font-size:13px;font-weight:600;color:var(--blue);flex:1}

/* ─ console ─ */
.cwrap{flex:1;overflow:hidden;display:flex;flex-direction:column}
.ctbar{
  padding:8px 12px;background:var(--panel);border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:8px;
}
#console{flex:1;overflow-y:auto;padding:6px 0;font-family:var(--mono);font-size:12px;line-height:1.75}
#console::-webkit-scrollbar{width:3px}
#console::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.ll{display:flex;gap:0;padding:2px 12px 2px 14px;border-left:2px solid transparent;transition:background .08s}
.ll:hover{background:rgba(255,255,255,.025)}
.lt{color:var(--tm);flex-shrink:0;font-size:10px;padding-top:2px;user-select:none;width:62px}
.lm{word-break:break-all;color:var(--td);flex:1}
.ll.warn{border-left-color:rgba(227,179,65,.6)}.ll.warn .lm{color:var(--amber)}
.ll.error{border-left-color:rgba(248,81,73,.7)}.ll.error .lm{color:var(--red)}
.ll.system{border-left-color:rgba(63,185,80,.5)}.ll.system .lm{color:var(--green);opacity:.9}
.ll.cmd{border-left-color:rgba(88,166,255,.6)}.ll.cmd .lm{color:var(--blue);font-weight:600}
.ll.player{border-left-color:rgba(188,140,255,.5)}.ll.player .lm{color:var(--purple)}
.ll.tick .lm{color:var(--blue);opacity:.55;font-size:10px}
.cmdbar{
  padding:10px 14px;background:var(--panel);border-top:1px solid var(--border);
  display:flex;gap:8px;align-items:center;flex-shrink:0;
}
.cpfx{font-family:var(--mono);color:var(--green);font-size:15px;font-weight:700;user-select:none}
#cmdi{flex:1;background:transparent;border:none;color:var(--t);font-family:var(--mono);font-size:13px;outline:none;caret-color:var(--green)}
#cmdi::placeholder{color:var(--tm)}
#cmdi:disabled{opacity:.3}
.fchip{
  padding:3px 10px;border-radius:99px;border:1px solid var(--border);background:transparent;
  color:var(--td);font-size:10px;font-family:var(--mono);cursor:pointer;transition:.15s;font-weight:600;
}
.fchip.on{border-color:var(--gdim);color:var(--green);background:var(--gglow)}
.fchip:hover:not(.on){border-color:var(--blight);color:var(--t)}

/* ─ players ─ */
.prow{
  display:flex;align-items:center;gap:10px;padding:10px 12px;
  background:var(--panel);border:1px solid var(--border);border-radius:10px;margin-bottom:6px;transition:.15s;
}
.prow:hover{border-color:var(--blight)}
.pavatar{
  width:34px;height:34px;border-radius:6px;overflow:hidden;
  background:var(--panel2);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;
}
.pavatar img{width:100%;height:100%;image-rendering:pixelated;display:block}
.pname{font-size:13px;font-weight:700}
.ptime{font-size:11px;font-family:var(--mono);color:var(--td);margin-top:1px}
.pacts{display:flex;gap:4px;flex-wrap:wrap;margin-left:auto}
.pchip{display:inline-block;padding:2px 8px;background:var(--panel2);border:1px solid var(--border);border-radius:99px;font-family:var(--mono);font-size:10px;color:var(--td);margin:2px 2px 2px 0}
.empty{text-align:center;padding:44px 20px;color:var(--td);font-family:var(--mono);font-size:12px}
.empty-i{font-size:40px;display:block;margin-bottom:12px;opacity:.4}

/* ─ version ─ */
.vtype{display:flex;gap:8px;margin-bottom:14px}
.vtb{
  flex:1;padding:14px 8px;border:2px solid var(--border);border-radius:12px;
  background:var(--panel2);cursor:pointer;text-align:center;transition:.2s;
}
.vtb:hover{border-color:var(--blight);transform:translateY(-2px)}
.vtb.active{border-color:var(--gdim);background:var(--gglow);box-shadow:0 0 16px rgba(63,185,80,.12)}
.vtb .vi{font-size:26px;display:block;margin-bottom:7px}
.vtb .vn{font-weight:700;font-size:13px}
.vtb .vs{font-size:10px;color:var(--td);font-family:var(--mono);margin-top:3px}
.vtb.active .vn{color:var(--green)}
.dlprog{background:var(--panel2);border:1px solid var(--border);border-radius:12px;padding:14px;display:none;margin-bottom:10px}
.dlprog.vis{display:block;animation:fadein .2s ease}
.pbar{background:var(--bg);border-radius:99px;height:6px;margin:9px 0;overflow:hidden}
.pbfill{height:100%;background:linear-gradient(90deg,var(--gdim),var(--green));border-radius:99px;transition:.35s;width:0}
.pbfill.done{background:var(--green)}.pbfill.err{background:var(--red)}
.dllabel{font-family:var(--mono);font-size:12px;color:var(--td)}
.dlpct{font-family:var(--mono);font-size:11px;color:var(--green);font-weight:600}

/* ─ properties ─ */
.pgrp{margin-bottom:20px}
.pgtitle{
  font-size:10px;font-family:var(--mono);color:var(--td);text-transform:uppercase;
  letter-spacing:.13em;margin-bottom:8px;display:flex;align-items:center;gap:10px;font-weight:600;
}
.pgtitle::after{content:'';flex:1;height:1px;background:var(--border)}
.proprow{
  display:flex;align-items:center;padding:9px 12px;
  background:var(--panel);border:1px solid var(--border);border-radius:8px;margin-bottom:4px;gap:10px;transition:.15s;
}
.proprow:hover{border-color:var(--blight)}
.propinfo{flex:1;min-width:0}
.propname{font-size:13px;font-weight:600}
.propkey{font-size:10px;font-family:var(--mono);color:var(--td);margin-top:1px}
.pinput{
  background:var(--panel2);border:1px solid var(--border);border-radius:6px;
  color:var(--t);font-family:var(--mono);font-size:12px;padding:6px 10px;width:150px;transition:.15s;
}
.pinput:focus{outline:none;border-color:var(--gdim)}
.pnarrow{width:80px}

/* ─ file list rows ─ */
.plrow{
  display:flex;align-items:center;gap:10px;padding:10px 12px;
  background:var(--panel);border:1px solid var(--border);border-radius:10px;margin-bottom:5px;transition:.15s;
}
.plrow:hover{border-color:var(--blight)}

/* ─ settings ─ */
.srow{display:flex;align-items:center;padding:12px 0;border-bottom:1px solid var(--border);gap:10px}
.srow:last-child{border:none;padding-bottom:0}
.slbl{flex:1}
.sname{font-size:13px;font-weight:600}
.sdesc{font-size:11px;font-family:var(--mono);color:var(--td);margin-top:2px}

/* ─ modal ─ */
.mbg{
  position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:200;
  display:none;align-items:center;justify-content:center;backdrop-filter:blur(6px);
}
.mbg.open{display:flex;animation:fadein .18s ease}
.modal{
  background:var(--panel);border:1px solid var(--border);border-radius:16px;
  padding:22px;width:320px;max-width:95vw;box-shadow:var(--shadow);
}
.mtitle{font-size:15px;font-weight:700;margin-bottom:8px}
.mbody{font-size:13px;color:var(--td);margin-bottom:14px;line-height:1.6}
.minput label{display:block;font-size:10px;font-family:var(--mono);color:var(--td);margin-bottom:5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.minput{margin-bottom:14px}
.macts{display:flex;gap:8px;justify-content:flex-end}

/* ─ toast ─ */
#toast{
  position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(80px);
  background:var(--panel);border:1px solid var(--border);border-radius:10px;
  padding:9px 18px;font-family:var(--mono);font-size:12px;font-weight:600;
  transition:transform .3s cubic-bezier(.34,1.56,.64,1);z-index:999;
  white-space:nowrap;box-shadow:var(--shadow);
}
#toast.show{transform:translateX(-50%) translateY(0)}
#toast.ok{border-color:var(--gdim);color:var(--green)}
#toast.err{border-color:rgba(248,81,73,.5);color:var(--red)}
#toast.info{border-color:rgba(88,166,255,.5);color:var(--blue)}

@media(max-width:580px){
  .sidebar{width:52px}.nb{width:42px;min-height:42px;font-size:15px}.nb .nl{display:none}
  .qgrid{grid-template-columns:1fr}.tstat.hs{display:none}
}
</style>
</head>
<body>
<div class="topbar">
  <div class="logo"><span class="logo-cube"></span>MC<span class="logo-em">Control</span><a href="https://discord.gg/u6tE8DzS5V" target="_blank" class="logo-by">by loaf1ms</a></div>
  <div class="topright">
    <div class="tstat hs"><span>CPU</span><span class="v" id="tCpu">─</span></div>
    <div class="tstat hs"><span>RAM</span><span class="v" id="tRam">─</span></div>
    <div class="tstat hs"><span>UP</span><span class="v" id="tUp">─</span></div>
    <div class="tstat"><span>👥</span><span class="g" id="tPl">0</span></div>
    <div id="pill" class="pill off"><div class="dot"></div><span id="ptxt">OFFLINE</span></div>
  </div>
</div>

<div class="layout">
<nav class="sidebar">
  <button class="nb active" data-tab="dash"       title="Dashboard">🏠<span class="nl">Home</span></button>
  <button class="nb"        data-tab="console"    title="Console">💻<span class="nl">Log</span></button>
  <button class="nb"        data-tab="players"    title="Players" id="nbPl">👥<span class="nl">Players</span></button>
  <div class="nsep"></div>
  <button class="nb"        data-tab="version"    title="Version">📦<span class="nl">Vers</span></button>
  <button class="nb"        data-tab="properties" title="Properties">⚙️<span class="nl">Props</span></button>
  <button class="nb"        data-tab="mods"       title="Mods">🧩<span class="nl">Mods</span></button>
  <button class="nb"        data-tab="plugins"    title="Plugins">🔌<span class="nl">Plugs</span></button>
  <div class="nsep"></div>
  <button class="nb nb-bot" data-tab="settings"   title="Settings">🔧<span class="nl">Setup</span></button>
</nav>

<div class="main">

<!-- DASHBOARD -->
<div class="tab active" id="tab-dash">
<div class="tcontent">

  <div class="status-hero" id="statusHero">
    <div class="sh-top" style="margin-bottom:10px">
      <div>
        <div class="sh-title">Minecraft Server</div>
        <div class="sh-sub" id="dStatus">● Offline</div>
      </div>
    </div>
    <div style="display:flex;gap:7px;flex-wrap:wrap">
      <button class="btn bg sm" id="btnStart" onclick="srvAct('start')">▶ Start</button>
      <button class="btn br sm" id="btnStop"  onclick="srvAct('stop')"  disabled>■ Stop</button>
      <button class="btn br sm" id="btnKill"  onclick="killSrv()"       disabled>☠ Force Kill</button>
    </div>
  </div>

  <div class="sgrid">
    <div class="sbox">
      <div class="gauge-wrap">
        <svg class="gauge" viewBox="0 0 52 52">
          <circle class="gauge-bg" cx="26" cy="26" r="21"/>
          <circle class="gauge-fill" id="cpuGaugeFill" cx="26" cy="26" r="21"/>
        </svg>
        <div class="gauge-pct" id="cpuGaugePct">─</div>
      </div>
      <div class="sbox-info">
        <div class="slabel">CPU Usage</div>
        <div class="sval" id="dCpu">─</div>
      </div>
    </div>
    <div class="sbox">
      <div class="gauge-wrap">
        <svg class="gauge" viewBox="0 0 52 52">
          <circle class="gauge-bg" cx="26" cy="26" r="21"/>
          <circle class="gauge-fill" id="ramGaugeFill" cx="26" cy="26" r="21"/>
        </svg>
        <div class="gauge-pct" id="ramGaugePct">─</div>
      </div>
      <div class="sbox-info">
        <div class="slabel">RAM Usage</div>
        <div class="sval" id="dRam">─</div>
      </div>
    </div>
    <div class="sbox">
      <div class="sbox-icon">👥</div>
      <div class="sbox-info">
        <div class="slabel">Online</div>
        <div class="sval sm2" id="dPl">0</div>
      </div>
    </div>
    <div class="sbox">
      <div class="sbox-icon">⏱</div>
      <div class="sbox-info">
        <div class="slabel">Uptime</div>
        <div class="sval dim" id="dUp">─</div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="ctitle">Quick Commands</div>
    <div class="qgrid">
      <button class="btn sm full" onclick="sc('time set day')">🌅 Set Day</button>
      <button class="btn sm full" onclick="sc('time set night')">🌙 Set Night</button>
      <button class="btn sm full" onclick="sc('weather clear')">☀ Clear Weather</button>
      <button class="btn sm full" onclick="sc('weather rain')">🌧 Rain</button>
      <button class="btn sm full" onclick="sc('save-all')">💾 Save World</button>
      <button class="btn sm full" onclick="openBcast()">📢 Broadcast</button>
      <button class="btn sm full" onclick="sc('difficulty peaceful')">🕊 Peaceful</button>
      <button class="btn sm full" onclick="sc('difficulty normal')">⚔️ Normal</button>
      <button class="btn sm full" onclick="sc('effect give @a minecraft:instant_health 1 255')">❤️ Heal All</button>
      <button class="btn sm full" onclick="sc('effect give @a minecraft:saturation 1 255')">🍖 Feed All</button>
    </div>
  </div>

  <div class="card" id="connectCard">
    <div class="ctitle">How to Connect</div>
    <div class="ci-grid">
      <div class="ci-row">
        <span class="ci-lbl">📡 IP Address</span>
        <span class="ci-val" id="ciIP">─</span>
        <button class="btn xs" onclick="copyTxt('ciIP')" title="Copy">⎘</button>
      </div>
      <div class="ci-row">
        <span class="ci-lbl">🔌 MC Port</span>
        <span class="ci-val">25565</span>
      </div>
      <div class="ci-row">
        <span class="ci-lbl">📦 Type</span>
        <span class="ci-val" id="ciType">─</span>
      </div>
      <div class="ci-row">
        <span class="ci-lbl">🏷 Version</span>
        <span class="ci-val" id="ciVer">─</span>
      </div>
    </div>
  </div>

</div>
</div>

<!-- CONSOLE -->
<div class="tab" id="tab-console">
<div class="cwrap">
  <div class="ctbar">
    <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
      <button class="fchip on" data-f="all"    onclick="setF('all')">All</button>
      <button class="fchip"    data-f="log"    onclick="setF('log')">Info</button>
      <button class="fchip"    data-f="warn"   onclick="setF('warn')">Warn</button>
      <button class="fchip"    data-f="error"  onclick="setF('error')">Error</button>
      <button class="fchip"    data-f="cmd"    onclick="setF('cmd')">Cmds</button>
      <button class="fchip"    data-f="system" onclick="setF('system')">Sys</button>
    </div>
    <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
      <label style="font-size:10px;font-family:var(--mono);color:var(--td);display:flex;gap:4px;cursor:pointer;align-items:center">
        <input type="checkbox" id="asc" checked style="accent-color:var(--green)"> Auto-scroll
      </label>
      <button class="btn sm" onclick="clrConsole()">Clear</button>
    </div>
  </div>
  <div id="console"></div>
  <div class="cmdbar">
    <span class="cpfx">/</span>
    <input id="cmdi" type="text" placeholder="Enter command..." disabled
           onkeydown="if(event.key==='Enter')sendCmd2()">
    <button class="btn bg sm" id="bSend" onclick="sendCmd2()" disabled>Send</button>
  </div>
</div>
</div>

<!-- PLAYERS -->
<div class="tab" id="tab-players">
<div class="tcontent">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
    <span style="font-size:12px;color:var(--td);font-family:var(--mono);font-weight:600" id="plCount">0 online</span>
    <div style="display:flex;gap:6px">
      <button class="btn sm" onclick="refreshPl()">🔄 Refresh</button>
      <button class="btn sm br" onclick="openBcast()">📢 Broadcast</button>
    </div>
  </div>
  <div id="plChips" style="margin-bottom:10px;min-height:4px"></div>
  <div id="plList"><div class="empty"><span class="empty-i">👥</span>No players online</div></div>
  <div class="card" style="margin-top:14px">
    <div class="ctitle">Target Player by Username</div>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <input class="inp" id="offPl" placeholder="Enter username..." style="flex:1">
    </div>
    <div style="margin-bottom:8px">
      <div style="font-size:9px;font-family:var(--mono);color:var(--td);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Admin</div>
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        <button class="btn xs bg" onclick="offAct('op')">⭐ OP</button>
        <button class="btn xs" onclick="offAct('deop')">✖ DeOP</button>
      </div>
    </div>
    <div style="margin-bottom:8px">
      <div style="font-size:9px;font-family:var(--mono);color:var(--td);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Moderation</div>
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        <button class="btn xs ba" onclick="offKick()">👢 Kick</button>
        <button class="btn xs br" onclick="offBan()">🔨 Ban</button>
        <button class="btn xs bg" onclick="offPardon()">✅ Unban / Pardon</button>
      </div>
    </div>
    <div style="margin-bottom:8px">
      <div style="font-size:9px;font-family:var(--mono);color:var(--td);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Whitelist</div>
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        <button class="btn xs" onclick="offAct2('whitelist add')">📋 Add</button>
        <button class="btn xs" onclick="offAct2('whitelist remove')">✖ Remove</button>
      </div>
    </div>
    <div>
      <div style="font-size:9px;font-family:var(--mono);color:var(--td);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Items</div>
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        <button class="btn xs bb" onclick="offAct2('give','Item ID (e.g. minecraft:diamond 64):')">🎁 Give Item</button>
      </div>
    </div>
  </div>
</div>
</div>

<!-- VERSION -->
<div class="tab" id="tab-version">
<div class="tcontent">
  <div class="card">
    <div class="ctitle">Server Software</div>
    <div class="vtype">
      <div class="vtb active" data-type="paper" onclick="selType('paper')">
        <span class="vi">📄</span><div class="vn">Paper</div><div class="vs">Recommended</div>
      </div>
      <div class="vtb" data-type="vanilla" onclick="selType('vanilla')">
        <span class="vi">🌿</span><div class="vn">Vanilla</div><div class="vs">Official</div>
      </div>
      <div class="vtb" data-type="fabric" onclick="selType('fabric')">
        <span class="vi">🧵</span><div class="vn">Fabric</div><div class="vs">Modloader</div>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <select class="inp" id="verSel" style="flex:1"><option>Loading...</option></select>
      <button class="btn bg" onclick="dlVer()" id="bDl">⬇ Download</button>
    </div>
    <p style="font-size:11px;color:var(--td);font-family:var(--mono)">Downloads to server.jar · EULA auto-accepted</p>
  </div>
  <div class="dlprog" id="dlProg">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div class="dllabel" id="dlName">Downloading...</div>
      <div class="dlpct" id="dlPct">0%</div>
    </div>
    <div class="pbar"><div class="pbfill" id="pbf"></div></div>
    <div class="dllabel" id="dlSub" style="color:var(--tm);margin-top:2px"></div>
  </div>
  <div class="card">
    <div class="ctitle">Current Server</div>
    <div style="font-family:var(--mono);font-size:12px;color:var(--td);line-height:2.2">
      <div>JAR: <span style="color:var(--t)" id="iJar">─</span></div>
      <div>Dir: <span style="color:var(--t)" id="iDir">─</span></div>
      <div>Found: <span id="iEx">─</span></div>
    </div>
  </div>
</div>
</div>

<!-- MODS -->
<div class="tab" id="tab-mods">
<div class="tcontent">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
    <span style="font-size:12px;color:var(--td);font-family:var(--mono);font-weight:600" id="modCount">0 mods</span>
    <button class="btn sm bg" onclick="loadMods()">🔄 Reload</button>
  </div>
  <div id="modList"><div class="empty"><span class="empty-i">🧩</span>Loading...</div></div>
  <div class="card" style="margin-top:14px">
    <div class="ctitle">Upload Mod</div>
    <input type="file" id="modFile" accept=".jar" style="display:none" onchange="modFileChosen()">
    <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center;flex-wrap:wrap">
      <button class="btn sm" onclick="document.getElementById('modFile').click()">📂 Select File</button>
      <span id="modFileName" style="font-size:12px;color:var(--td);font-family:var(--mono);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">No file selected</span>
      <button class="btn sm bg" onclick="uploadMod()" id="bUpMod" disabled>📤 Upload</button>
    </div>
    <div id="upStatus" style="font-size:11px;color:var(--td);font-family:var(--mono);display:none;margin-top:8px"></div>
  </div>
</div>
</div>

<!-- PROPERTIES -->
<div class="tab" id="tab-properties">
<div class="tcontent">
  <div style="display:flex;gap:8px;margin-bottom:12px">
    <input class="inp" id="psrch" placeholder="Search properties..." oninput="fProps(this.value)" style="flex:1">
    <button class="btn bg" onclick="saveProps()">💾 Save All</button>
  </div>
  <div id="propsBox"></div>
</div>
</div>

<!-- PLUGINS -->
<div class="tab" id="tab-plugins">
<div class="tcontent">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
    <span style="font-size:12px;color:var(--td);font-family:var(--mono);font-weight:600" id="plgCount">0 plugins</span>
    <button class="btn sm bg" onclick="loadPlgs()">🔄 Reload</button>
  </div>
  <div id="plgList"><div class="empty"><span class="empty-i">🔌</span>Loading...</div></div>
  <div class="card" style="margin-top:10px">
    <div class="ctitle">Upload Plugin</div>
    <input type="file" id="plgFile" accept=".jar" style="display:none" onchange="plgFileChosen()">
    <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center;flex-wrap:wrap">
      <button class="btn sm" onclick="document.getElementById('plgFile').click()">📂 Select File</button>
      <span id="plgFileName" style="font-size:12px;color:var(--td);font-family:var(--mono);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">No file selected</span>
      <button class="btn sm bg" onclick="uploadPlg()" id="bUpPlg" disabled>📤 Upload</button>
    </div>
    <div id="upPlgStatus" style="font-size:11px;color:var(--td);font-family:var(--mono);display:none;margin-top:8px"></div>
  </div>
  <div class="card" style="margin-top:10px">
    <div class="ctitle">Plugin Actions</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn sm" onclick="sc('plugman reload all')">🔄 PlugMan Reload All</button>
      <button class="btn sm" onclick="sc('reload confirm')">⚡ /reload confirm</button>
    </div>
    <p style="font-size:11px;color:var(--td);font-family:var(--mono);margin-top:10px">⚠️ Full restart is always safer than /reload</p>
  </div>
</div>
</div>

<!-- SETTINGS -->
<div class="tab" id="tab-settings">
<div class="tcontent">
  <div class="card">
    <div class="ctitle">Server Config</div>
    <div class="srow">
      <div class="slbl"><div class="sname">RAM Allocation</div><div class="sdesc">Max JVM heap (1G, 2G, 512M...)</div></div>
      <input class="inp" id="sRam" placeholder="1G" style="width:90px">
    </div>
    <div class="srow">
      <div class="slbl"><div class="sname">Server JAR</div><div class="sdesc">JAR filename in server directory</div></div>
      <input class="inp" id="sJar" placeholder="server.jar" style="width:150px">
    </div>
    <div class="srow">
      <div class="slbl"><div class="sname">Server Directory</div><div class="sdesc">Full path to server folder</div></div>
      <input class="inp" id="sDir" placeholder="~/minecraft" style="width:200px">
    </div>
    <div class="srow">
      <div class="slbl"><div class="sname">Java Path</div><div class="sdesc">Path to java binary</div></div>
      <input class="inp" id="sJava" placeholder="java" style="width:140px">
    </div>
    <div style="margin-top:14px"><button class="btn bg" onclick="saveSettings()">💾 Save Settings</button></div>
  </div>
  <div class="card">
    <div class="ctitle">Termux Tips</div>
    <div style="font-size:12px;color:var(--td);line-height:2.3;font-family:var(--mono)">
      <div>• <span style="color:var(--amber)">termux-wake-lock</span> — stop Android killing the server</div>
      <div>• <span style="color:var(--amber)">pkg install tmux</span> — run server in background</div>
      <div>• Keep phone plugged in — Java uses a lot of battery</div>
      <div>• Set view-distance=6 in Properties for better performance</div>
      <div>• Paper runs much better than Vanilla on Android (ARM)</div>
    </div>
  </div>
  <div class="card">
    <div class="ctitle">Connection Info</div>
    <div style="font-size:12px;color:var(--td);font-family:var(--mono);line-height:2.3">
      <div>Panel: <span style="color:var(--blue)" id="aLAN">─</span></div>
      <div>MC Port: <span style="color:var(--t)">25565</span> (local WiFi)</div>
    </div>
  </div>
</div>
</div>

</div><!-- /main -->
</div><!-- /layout -->

<!-- Modal -->
<div class="mbg" id="modal">
  <div class="modal">
    <div class="mtitle" id="mtitle">─</div>
    <div class="mbody"  id="mbody"></div>
    <div id="minputs"></div>
    <div class="macts">
      <button class="btn sm" onclick="closeM()">Cancel</button>
      <button class="btn sm bg" id="mconf">Confirm</button>
    </div>
  </div>
</div>
<div id="toast"></div>
<script>
let ws,isRunning=false,curF='all',allLogs=[],players=[],selT='paper',propsData={};

function connect(){
  const p=location.protocol==='https:'?'wss':'ws';
  ws=new WebSocket(p+'://'+location.host);
  ws.onmessage=e=>handle(JSON.parse(e.data));
  ws.onclose=()=>setTimeout(connect,2000);
}

function handle(m){
  if(m.type==='history'){allLogs=[];document.getElementById('console').innerHTML='';m.logs.forEach(l=>alog(l,true));}
  else if(m.type==='log') alog(m);
  else if(m.type==='status'){setR(m.running);if(m.players!=null)setPl(m.players);if(m.uptime!=null)setUp(m.uptime);}
  else if(m.type==='players') setPl(m.players);
  else if(m.type==='uptime')  setUp(m.uptime);
  else if(m.type==='config')  apCfg(m.config);
  else if(m.type==='stats')  updStats(m);
  else if(m.type==='download') updDl(m);
  else if(m.type==='jarReady'){toast('Download done! Ready to start.','ok');loadVI();}
}

function alog(e,s=false){
  allLogs.push(e);
  if(allLogs.length>2000)allLogs.shift();
  if(curF!=='all'&&e.type!==curF)return;
  rlog(e);
}

function rlog(e){
  const c=document.getElementById('console');
  const d=document.createElement('div');d.className='ll '+(e.type||'log');d.dataset.type=e.type||'log';
  const t=document.createElement('span');t.className='lt';t.textContent=e.time||'';
  const m=document.createElement('span');m.className='lm';m.textContent=e.text;
  d.append(t,m);c.appendChild(d);
  const a=document.getElementById('asc');
  if(a&&a.checked)c.scrollTop=c.scrollHeight;
}

function setF(f){
  curF=f;
  document.querySelectorAll('.fchip').forEach(c=>c.classList.toggle('on',c.dataset.f===f));
  const c=document.getElementById('console');c.innerHTML='';
  allLogs.forEach(l=>{if(f==='all'||l.type===f)rlog(l);});
}

function clrConsole(){document.getElementById('console').innerHTML='';allLogs=[];}

async function sendCmd2(){
  const i=document.getElementById('cmdi');const cmd=i.value.trim();if(!cmd)return;i.value='';
  const r=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:cmd})});
  const d=await r.json();if(d.error)toast(d.error,'err');
}

async function srvAct(a){
  const r=await fetch('/api/'+a,{method:'POST'});const d=await r.json();
  if(d.error)toast(d.error,'err');else toast(a==='start'?'Starting...':'Stopping...','ok');
}

async function killSrv(){
  if(!confirm('Force kill? World may not save!'))return;
  const r=await fetch('/api/kill',{method:'POST'});const d=await r.json();
  toast(d.error||'Killed',d.error?'err':'ok');
}

async function sc(cmd){
  if(!isRunning){toast('Server not running','err');return;}
  const r=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:cmd})});
  const d=await r.json();if(d.error)toast(d.error,'err');else toast('/'+cmd,'ok');
}

function setR(r){
  isRunning=r;
  const pi=document.getElementById('pill'),pt=document.getElementById('ptxt');
  pi.className='pill '+(r?'on':'off');pt.textContent=r?'ONLINE':'OFFLINE';
  const ds=document.getElementById('dStatus');
  ds.textContent=r?'● Online':'● Offline';
  ds.className='sh-sub'+(r?' online':'');
  const hero=document.getElementById('statusHero');
  if(hero)hero.className='status-hero'+(r?' online':'');
  document.getElementById('btnStart').disabled=r;
  document.getElementById('btnStop').disabled=!r;
  document.getElementById('btnKill').disabled=!r;
  document.getElementById('cmdi').disabled=!r;
  document.getElementById('bSend').disabled=!r;
  if(!r){setUp(null);setPl([]);}
}

function setPl(list){
  players=list||[];const n=players.length;
  document.getElementById('tPl').textContent=n;
  document.getElementById('dPl').textContent=n;
  document.getElementById('plCount').textContent=n+' online';
  const nb=document.getElementById('nbPl');
  let b=nb.querySelector('.bdg');
  if(n>0){if(!b){b=document.createElement('div');b.className='bdg';nb.appendChild(b);}b.textContent=n>9?'9+':n;}
  else if(b)b.remove();
  const chips=document.getElementById('plChips');
  if(chips)chips.innerHTML=players.map(p=>\`<span class="pchip">\${esc(p.name)}</span>\`).join('');
  renderPl();
}

function setUp(u){
  const v=u||'─';
  document.getElementById('tUp').textContent=v;
  document.getElementById('dUp').textContent=v;
}

function updStats(s){
  const circ=131.95; // 2π×21
  const cpuCls=s.cpu>70?'crit':s.cpu>40?'warn':'';
  const ramCls=s.ram>80?'crit':s.ram>60?'warn':'';
  const cpuCol=s.cpu>70?'var(--red)':s.cpu>40?'var(--amber)':'var(--green)';
  const ramCol=s.ram>80?'var(--red)':s.ram>60?'var(--amber)':'var(--green)';
  const cpuEl=document.getElementById('dCpu');const ramEl=document.getElementById('dRam');
  cpuEl.textContent=s.cpu+'%';cpuEl.style.color=cpuCol;
  ramEl.textContent=s.ram+'%';ramEl.style.color=ramCol;
  document.getElementById('tCpu').textContent=s.cpu+'%';
  document.getElementById('tRam').textContent=s.ram+'%';
  const cpuG=document.getElementById('cpuGaugeFill');
  const ramG=document.getElementById('ramGaugeFill');
  const cpuP=document.getElementById('cpuGaugePct');
  const ramP=document.getElementById('ramGaugePct');
  if(cpuG){cpuG.style.strokeDasharray=\`\${s.cpu/100*circ} \${circ}\`;cpuG.className='gauge-fill'+(cpuCls?' '+cpuCls:'');}
  if(ramG){ramG.style.strokeDasharray=\`\${s.ram/100*circ} \${circ}\`;ramG.className='gauge-fill'+(ramCls?' '+ramCls:'');}
  if(cpuP)cpuP.style.color=cpuCol;
  if(ramP)ramP.style.color=ramCol;
}

function apCfg(c){
  if(!c)return;
  document.getElementById('sRam').value=c.memory||'';
  document.getElementById('sJar').value=c.serverJar||'';
  document.getElementById('sDir').value=c.serverDir||'';
  document.getElementById('sJava').value=c.javaPath||'';
  document.getElementById('iJar').textContent=c.serverJar||'─';
  document.getElementById('iDir').textContent=c.serverDir||'─';
  const ciType=document.getElementById('ciType');
  const ciVer=document.getElementById('ciVer');
  if(ciType&&c.serverType)ciType.textContent=c.serverType.charAt(0).toUpperCase()+c.serverType.slice(1);
  if(ciVer&&c.serverVersion)ciVer.textContent=c.serverVersion;
}

// ─ Players ─
function renderPl(){
  const el=document.getElementById('plList');
  if(!players.length){el.innerHTML='<div class="empty"><span class="empty-i">👥</span>No players online</div>';return;}
  el.innerHTML=players.map(p=>\`
    <div class="prow">
      <div class="pavatar"><img src="https://crafatar.com/avatars/\${esc(p.name)}?size=34&overlay=true" alt="\${esc(p.name)}" onerror="this.outerHTML='🧑'"></div>
      <div><div class="pname">\${esc(p.name)}</div><div class="ptime">● Online</div></div>
      <div class="pacts">
        <button class="btn xs bg" onclick="plAct('op','\${esc(p.name)}')">⭐ OP</button>
        <button class="btn xs" onclick="plAct('creative','\${esc(p.name)}')">🎨</button>
        <button class="btn xs" onclick="plAct('survival','\${esc(p.name)}')">⚔️</button>
        <button class="btn xs" onclick="plAct('spectator','\${esc(p.name)}')">👁</button>
        <button class="btn xs bb" onclick="plAct('heal','\${esc(p.name)}')">❤️</button>
        <button class="btn xs bb" onclick="plAct('feed','\${esc(p.name)}')">🍖</button>
        <button class="btn xs" onclick="openTp('\${esc(p.name)}')">📍 TP</button>
        <button class="btn xs ba" onclick="openKick('\${esc(p.name)}')">👢 Kick</button>
        <button class="btn xs br" onclick="openBan('\${esc(p.name)}')">🔨 Ban</button>
      </div>
    </div>
  \`).join('');
}

async function plAct(a,name){
  if(!isRunning){toast('Server not running','err');return;}
  const r=await fetch('/api/player/'+a,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
  const d=await r.json();toast(d.error||(a+' → '+name),d.error?'err':'ok');
}

function refreshPl(){if(!isRunning){toast('Not running','err');return;}sc('list');toast('Refreshed','info');}

function openKick(n){openM('Kick '+n,'Kick reason','Reason',async v=>{
  const r=await fetch('/api/player/kick',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,extra:v||'Kicked'})});
  const d=await r.json();toast(d.error||'Kicked '+n,d.error?'err':'ok');
},'Kicked by admin');}

function openBan(n){openM('Ban '+n,'Ban reason','Reason',async v=>{
  const r=await fetch('/api/player/ban',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,extra:v||'Banned'})});
  const d=await r.json();toast(d.error||'Banned '+n,d.error?'err':'ok');
},'Rule violation');}

function openTp(n){openM('Teleport '+n,'x y z coordinates or player name','Destination',async v=>{
  if(!v){toast('Enter destination','err');return;}
  await sc('tp '+n+' '+v);toast('Teleporting '+n,'ok');
});}

function openBcast(){openM('Broadcast','Message all players','Message',async v=>{
  if(!v)return;await sc('broadcast '+v);toast('Broadcast sent','ok');
});}

function offAct(a){
  const n=document.getElementById('offPl').value.trim();
  if(!n){toast('Enter a username first','err');return;}
  if(!isRunning){toast('Server not running','err');return;}
  const cmd=a==='unban'?'pardon':a;
  sc(cmd+' '+n);
}

function offAct2(a,prompt){
  const n=document.getElementById('offPl').value.trim();
  if(!n){toast('Enter a username first','err');return;}
  if(!isRunning){toast('Server not running','err');return;}
  if(prompt){
    openM(a+' '+n,prompt,'Value',async v=>{if(v)sc(a+' '+n+' '+v);});
  } else {
    sc(a+' '+n);
  }
}

function offKick(){
  const n=document.getElementById('offPl').value.trim();
  if(!n){toast('Enter a username first','err');return;}
  if(!isRunning){toast('Server not running','err');return;}
  openM('Kick '+n,'Kick reason (optional)','Reason',async v=>{
    const r=await fetch('/api/player/kick',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,extra:v||'Kicked by admin'})});
    const d=await r.json();toast(d.error||'Kicked '+n,d.error?'err':'ok');
  },'Kicked by admin');
}

function offBan(){
  const n=document.getElementById('offPl').value.trim();
  if(!n){toast('Enter a username first','err');return;}
  if(!isRunning){toast('Server not running','err');return;}
  openM('Ban '+n,'Ban reason','Reason',async v=>{
    const r=await fetch('/api/player/ban',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,extra:v||'Banned by admin'})});
    const d=await r.json();toast(d.error||'Banned '+n,d.error?'err':'ok');
  },'Rule violation');
}

function offPardon(){
  const n=document.getElementById('offPl').value.trim();
  if(!n){toast('Enter a username first','err');return;}
  if(!isRunning){toast('Server not running','err');return;}
  sc('pardon '+n);toast('Pardon sent for '+n,'ok');
}

// ─ Version ─
function selType(t){
  selT=t;
  document.querySelectorAll('.vtb').forEach(b=>b.classList.toggle('active',b.dataset.type===t));
  loadVerList();
}

async function loadVerList(){
  const sel=document.getElementById('verSel');
  sel.innerHTML='<option>Loading...</option>';
  try{
    const r=await fetch('/api/versions/'+selT);const d=await r.json();
    if(d.error)throw new Error(d.error);
    sel.innerHTML=d.versions.slice(0,30).map(v=>\`<option>\${v}</option>\`).join('');
  }catch(e){sel.innerHTML='<option>Error: '+e.message+'</option>';}
}

async function dlVer(){
  const ver=document.getElementById('verSel').value;
  if(!ver||ver.includes('Loading')||ver.includes('Error')){toast('Pick a version','err');return;}
  document.getElementById('bDl').disabled=true;
  const prog=document.getElementById('dlProg');prog.classList.add('vis');
  document.getElementById('pbf').style.width='0';document.getElementById('pbf').className='pbfill';
  document.getElementById('dlPct').textContent='0%';
  document.getElementById('dlName').textContent='Downloading '+selT+' '+ver+'...';
  document.getElementById('dlSub').textContent='';
  const r=await fetch('/api/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:selT,version:ver})});
  const d=await r.json();if(d.error){toast(d.error,'err');document.getElementById('bDl').disabled=false;}
}

function updDl(d){
  document.getElementById('dlProg').classList.add('vis');
  const pct=d.total>0?Math.round(d.progress/d.total*100):0;
  const b=document.getElementById('pbf');
  document.getElementById('dlPct').textContent=pct+'%';
  document.getElementById('dlName').textContent=d.name||'Downloading...';
  b.style.width=pct+'%';
  if(d.total>0) document.getElementById('dlSub').textContent=fmtB(d.progress)+' / '+fmtB(d.total);
  if(d.done){b.className='pbfill done';document.getElementById('dlPct').textContent='100%';document.getElementById('dlSub').textContent='Complete!';document.getElementById('bDl').disabled=false;}
  if(d.error){b.className='pbfill err';document.getElementById('dlSub').textContent='Error: '+d.error;document.getElementById('bDl').disabled=false;}
}

function fmtB(b){if(b>1048576)return(b/1048576).toFixed(1)+' MB';if(b>1024)return(b/1024).toFixed(0)+' KB';return b+' B';}

async function loadVI(){
  const r=await fetch('/api/status');const d=await r.json();
  const ex=document.getElementById('iEx');
  ex.textContent=d.jarExists?'✅ Yes':'❌ No';
  ex.style.color=d.jarExists?'var(--green)':'var(--red)';
  setR(d.running);setPl(d.players);setUp(d.uptime);apCfg(d.config);
}

// ─ Properties ─
const PDEF={'server-name':'A Minecraft Server','motd':'A Minecraft Server','max-players':'20','gamemode':'survival','difficulty':'easy','level-name':'world','level-type':'minecraft:default','level-seed':'','server-port':'25565','online-mode':'true','white-list':'false','view-distance':'10','simulation-distance':'10','max-tick-time':'60000','network-compression-threshold':'256','pvp':'true','spawn-monsters':'true','spawn-animals':'true','spawn-npcs':'true','allow-nether':'true','allow-flight':'false','generate-structures':'true','spawn-protection':'16','enable-command-block':'false','force-gamemode':'false','hardcore':'false','enable-rcon':'false','rcon.port':'25575','enable-query':'false'};
const PMETA={
  'server-name':         {l:'Server Name',       g:'General'},
  'motd':                {l:'MOTD',              g:'General'},
  'max-players':         {l:'Max Players',       g:'General',t:'number'},
  'gamemode':            {l:'Default Gamemode',  g:'General',t:'sel',o:['survival','creative','adventure','spectator']},
  'difficulty':          {l:'Difficulty',        g:'General',t:'sel',o:['peaceful','easy','normal','hard']},
  'level-name':          {l:'World Name',        g:'General'},
  'level-type':          {l:'World Type',        g:'General',t:'sel',o:['minecraft:default','minecraft:flat','minecraft:large_biomes','minecraft:amplified']},
  'level-seed':          {l:'Seed',              g:'General'},
  'server-port':         {l:'Port',              g:'Network',t:'number'},
  'online-mode':         {l:'Online Mode',       g:'Network',t:'bool'},
  'white-list':          {l:'Whitelist',         g:'Network',t:'bool'},
  'view-distance':       {l:'View Distance',     g:'Performance',t:'number'},
  'simulation-distance': {l:'Simulation Distance',g:'Performance',t:'number'},
  'max-tick-time':       {l:'Max Tick Time (ms)',g:'Performance',t:'number'},
  'network-compression-threshold':{l:'Compression Threshold',g:'Performance',t:'number'},
  'pvp':                 {l:'PvP',               g:'World',t:'bool'},
  'spawn-monsters':      {l:'Spawn Monsters',    g:'World',t:'bool'},
  'spawn-animals':       {l:'Spawn Animals',     g:'World',t:'bool'},
  'spawn-npcs':          {l:'Spawn Villagers',   g:'World',t:'bool'},
  'allow-nether':        {l:'Allow Nether',      g:'World',t:'bool'},
  'allow-flight':        {l:'Allow Flight',      g:'World',t:'bool'},
  'generate-structures': {l:'Generate Structures',g:'World',t:'bool'},
  'spawn-protection':    {l:'Spawn Protection',  g:'World',t:'number'},
  'enable-command-block':{l:'Command Blocks',    g:'World',t:'bool'},
  'force-gamemode':      {l:'Force Gamemode',    g:'Rules',t:'bool'},
  'hardcore':            {l:'Hardcore',          g:'Rules',t:'bool'},
  'enable-rcon':         {l:'RCON',              g:'Advanced',t:'bool'},
  'rcon.port':           {l:'RCON Port',         g:'Advanced',t:'number'},
  'enable-query':        {l:'Query',             g:'Advanced',t:'bool'},
};

async function loadProps(){
  const r=await fetch('/api/properties');propsData=await r.json();
  renderP(propsData,'');
}

function renderP(data,srch){
  const grps={};
  for(const[k,m]of Object.entries(PMETA)){
    const v=data[k]!==undefined?data[k]:(m.t==='bool'?'false':'');
    if(srch&&!k.includes(srch.toLowerCase())&&!m.l.toLowerCase().includes(srch.toLowerCase()))continue;
    if(!grps[m.g])grps[m.g]=[];
    grps[m.g].push({k,m,v});
  }
  const other=[];
  for(const[k,v]of Object.entries(data)){
    if(!PMETA[k]){if(srch&&!k.includes(srch.toLowerCase()))continue;other.push({k,v});}
  }
  let html='';
  for(const[g,props]of Object.entries(grps)){
    html+=\`<div class="pgrp"><div class="pgtitle">\${g}</div>\`;
    for(const{k,m,v}of props){
      let inp='';
      if(m.t==='bool'){
        inp=\`<select class="pinput pnarrow" data-key="\${k}">
          <option value="true" \${v==='true'?'selected':''}>true</option>
          <option value="false" \${v!=='true'?'selected':''}>false</option>
        </select>\`;
      }else if(m.t==='sel'){
        inp=\`<select class="pinput" data-key="\${k}">\${m.o.map(o=>\`<option \${v===o?'selected':''}>\${o}</option>\`).join('')}</select>\`;
      }else{
        const def=PDEF[k]!==undefined?\` placeholder="\${esc(PDEF[k])} (default)"\`:'';
        inp=\`<input class="pinput" data-key="\${k}" type="\${m.t||'text'}" value="\${esc(v)}"\${def}>\`;
      }
      html+=\`<div class="proprow"><div class="propinfo"><div class="propname">\${m.l}</div><div class="propkey">\${k}</div></div>\${inp}</div>\`;
    }
    html+=\`</div>\`;
  }
  if(other.length){
    html+=\`<div class="pgrp"><div class="pgtitle">Other</div>\`;
    for(const{k,v}of other)
      html+=\`<div class="proprow"><div class="propinfo"><div class="propname">\${k}</div></div><input class="pinput" data-key="\${k}" value="\${esc(v)}"></div>\`;
    html+=\`</div>\`;
  }
  if(!html)html='<div class="empty"><span class="empty-i">🔍</span>No properties found</div>';
  document.getElementById('propsBox').innerHTML=html;
}

function fProps(q){renderP(propsData,q);}

async function saveProps(){
  const updated={};
  document.querySelectorAll('[data-key]').forEach(el=>updated[el.dataset.key]=el.value);
  const r=await fetch('/api/properties',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(updated)});
  const d=await r.json();toast(d.error||'Saved! Restart server to apply.','ok');
}

// ─ Mods ─
async function loadMods(){
  const r=await fetch('/api/mods');const d=await r.json();
  document.getElementById('modCount').textContent=(d.mods?.length||0)+' mods';
  const el=document.getElementById('modList');
  if(!d.mods?.length){el.innerHTML='<div class="empty"><span class="empty-i">🧩</span>No mods in mods/ folder</div>';return;}
  el.innerHTML=d.mods.map(m=>\`
    <div class="plrow">
      <span style="font-size:20px">🧩</span>
      <div style="flex:1"><div style="font-size:13px;font-weight:600">\${esc(m.name)}</div>
        <div style="font-size:11px;font-family:var(--mono);color:var(--td)">\${fmtB(m.size)}</div></div>
      <button class="btn xs br" onclick="delMod('\${esc(m.name)}')">🗑 Delete</button>
    </div>
  \`).join('');
}

async function delMod(n){
  if(!confirm('Delete '+n+'?'))return;
  const r=await fetch('/api/mods/'+encodeURIComponent(n),{method:'DELETE'});
  const d=await r.json();toast(d.error||'Deleted',d.error?'err':'ok');
  if(!d.error)loadMods();
}

async function uploadMod(){
  const fi=document.getElementById('modFile');
  if(!fi||!fi.files[0]){toast('Select a mod file','err');return;}
  const f=fi.files[0];
  if(!f.name.endsWith('.jar')){toast('Only .jar files allowed','err');return;}
  if(f.size>500*1024*1024){toast('File too large (max 500MB)','err');return;}
  
  const st=document.getElementById('upStatus');
  if(!st){toast('UI error','err');return;}
  st.style.display='block';st.textContent='Reading file...';
  
  const reader=new FileReader();
  reader.onload=async e=>{
    try{
      const b64=e.target.result.split(',')[1];
      st.textContent='Uploading '+f.name+'...';
      const r=await fetch('/api/mods/upload',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({filename:f.name,data:b64})
      });
      const d=await r.json();
      if(d.error){
        toast(d.error,'err');st.textContent='Error: '+d.error;
      }else{
        toast('Mod uploaded!','ok');
        st.textContent='✅ Uploaded successfully';
        fi.value='';document.getElementById('modFileName').textContent='No file selected';document.getElementById('bUpMod').disabled=true;
        setTimeout(()=>{st.style.display='none';loadMods();},1500);
      }
    }catch(e){
      toast(e.message,'err');st.textContent='Error: '+e.message;
    }
  };
  reader.onerror=()=>{toast('Failed to read file','err');st.style.display='none';};
  reader.readAsDataURL(f);
}

// ─ Plugins ─
async function uploadPlg(){
  const fi=document.getElementById('plgFile');
  if(!fi||!fi.files[0]){toast('Select a plugin file','err');return;}
  const f=fi.files[0];
  if(!f.name.endsWith('.jar')){toast('Only .jar files allowed','err');return;}
  if(f.size>500*1024*1024){toast('File too large (max 500MB)','err');return;}
  const st=document.getElementById('upPlgStatus');
  st.style.display='block';st.textContent='Reading file...';
  const reader=new FileReader();
  reader.onload=async e=>{
    try{
      st.textContent='Uploading '+f.name+'...';
      const r=await fetch('/api/plugins/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:f.name,data:e.target.result.split(',')[1]})});
      const d=await r.json();
      if(d.error){toast(d.error,'err');st.textContent='Error: '+d.error;}
      else{toast('Plugin uploaded!','ok');st.textContent='\u2705 Uploaded';fi.value='';document.getElementById('plgFileName').textContent='No file selected';document.getElementById('bUpPlg').disabled=true;setTimeout(()=>{st.style.display='none';loadPlgs();},1500);}
    }catch(e){toast(e.message,'err');st.textContent='Error: '+e.message;}
  };
  reader.onerror=()=>{toast('Failed to read file','err');st.style.display='none';};
  reader.readAsDataURL(f);
}

async function loadPlgs(){
  const r=await fetch('/api/plugins');const d=await r.json();
  document.getElementById('plgCount').textContent=(d.plugins?.length||0)+' plugins';
  const el=document.getElementById('plgList');
  if(!d.plugins?.length){el.innerHTML='<div class="empty"><span class="empty-i">🔌</span>No plugins in plugins/ folder</div>';return;}
  el.innerHTML=d.plugins.map(p=>\`
    <div class="plrow">
      <span style="font-size:20px">🔌</span>
      <div style="flex:1"><div style="font-size:13px;font-weight:600">\${esc(p.name)}</div>
        <div style="font-size:11px;font-family:var(--mono);color:var(--td)">\${fmtB(p.size)}</div></div>
      <button class="btn xs br" onclick="delPlg('\${esc(p.name)}')">🗑 Delete</button>
    </div>
  \`).join('');
}

async function delPlg(n){
  if(!confirm('Delete '+n+'?'))return;
  const r=await fetch('/api/plugins/'+encodeURIComponent(n),{method:'DELETE'});
  const d=await r.json();toast(d.error||'Deleted',d.error?'err':'ok');
  if(!d.error)loadPlgs();
}

// ─ Settings ─
async function saveSettings(){
  const body={memory:document.getElementById('sRam').value,serverJar:document.getElementById('sJar').value,
    serverDir:document.getElementById('sDir').value,javaPath:document.getElementById('sJava').value};
  const r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json();toast(d.error||'Saved!',d.error?'err':'ok');if(!d.error)apCfg(d.config);
}

// ─ Tab nav ─
document.querySelectorAll('.nb[data-tab]').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const t=btn.dataset.tab;
    document.querySelectorAll('.nb').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(el=>el.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-'+t).classList.add('active');
    if(t==='properties')loadProps();
    if(t==='plugins')loadPlgs();
    if(t==='mods')loadMods();
    if(t==='version')loadVI();
  });
});

// ─ Modal ─
let mcb=null;
function openM(title,body,lbl,cb,def=''){
  document.getElementById('mtitle').textContent=title;
  document.getElementById('mbody').textContent=body;
  document.getElementById('minputs').innerHTML=
    \`<div class="minput"><label>\${lbl}</label><input class="inp" id="mi" value="\${esc(def)}"></div>\`;
  mcb=cb;document.getElementById('modal').classList.add('open');
  setTimeout(()=>document.getElementById('mi')?.focus(),100);
}
function closeM(){document.getElementById('modal').classList.remove('open');}
document.getElementById('mconf').onclick=async()=>{
  const v=document.getElementById('mi')?.value||'';closeM();if(mcb)await mcb(v);
};
document.getElementById('modal').onclick=e=>{if(e.target===e.currentTarget)closeM();};

// ─ Toast ─
let tt;
function toast(msg,type='ok'){
  const t=document.getElementById('toast');t.textContent=msg;t.className='show '+type;
  clearTimeout(tt);tt=setTimeout(()=>t.className='',2500);
}

// ─ Util ─
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

function modFileChosen(){
  const fi=document.getElementById('modFile');
  const nm=document.getElementById('modFileName');
  const btn=document.getElementById('bUpMod');
  if(fi.files[0]){nm.textContent=fi.files[0].name;btn.disabled=false;}
}
function plgFileChosen(){
  const fi=document.getElementById('plgFile');
  const nm=document.getElementById('plgFileName');
  const btn=document.getElementById('bUpPlg');
  if(fi.files[0]){nm.textContent=fi.files[0].name;btn.disabled=false;}
}

// ─ Copy util ─
function copyTxt(id){
  const el=document.getElementById(id);
  if(!el)return;
  navigator.clipboard.writeText(el.textContent).then(()=>toast('Copied!','ok')).catch(()=>{
    const ta=document.createElement('textarea');ta.value=el.textContent;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();toast('Copied!','ok');
  });
}

// ─ Init ─
connect();loadVerList();
document.getElementById('aLAN').textContent=location.host;
document.getElementById('ciIP').textContent=location.hostname;

document.addEventListener('keydown',e=>{
  if(e.key==='/'&&document.activeElement.tagName!=='INPUT'&&document.activeElement.tagName!=='SELECT'){
    e.preventDefault();
    document.querySelector('[data-tab="console"]').click();
    setTimeout(()=>document.getElementById('cmdi').focus(),50);
  }
});
</script>
</body>
</html>`;

app.get('/', (_, res) => res.send(PAGE));
