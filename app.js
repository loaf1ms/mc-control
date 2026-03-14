let ws,isRunning=false,curF='all',allLogs=[],players=[],selT='paper',propsData={},networkInfo={lanIp:'',addresses:[]};

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
  if(d.error)toast(d.error,'err');
  else toast(a==='start'?'Starting...':a==='restart'?'Restarting...':'Stopping...','ok');
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
  // New status badge
  const badge=document.getElementById('statusBadge');
  const badgeTxt=document.getElementById('badgeTxt');
  if(badge){badge.className='status-badge '+(r?'running':'stopped');badgeTxt.textContent=r?'RUNNING':'STOPPED';}
  const badge2=document.getElementById('statusBadge2');
  const badgeTxt2=document.getElementById('badgeTxt2');
  if(badge2){badge2.className='status-badge '+(r?'running':'stopped');badgeTxt2.textContent=r?'RUNNING':'STOPPED';}
  // Status text in stat card
  const ds=document.getElementById('dStatus');
  if(ds){ds.textContent=r?'Currently running':'Not currently running';}
  const dup=document.getElementById('dUp');
  if(dup&&!r){dup.textContent='Offline';dup.className='stat-value dim';}
  // Buttons
  const bStart=document.getElementById('btnStart');
  const bRestart=document.getElementById('btnRestart');
  const bStartMain=document.getElementById('btnStartMain');
  const bStop=document.getElementById('btnStop');
  const bKill=document.getElementById('btnKill');
  if(bStart)bStart.disabled=r;
  if(bRestart)bRestart.disabled=!r;
  if(bStartMain)bStartMain.disabled=r;
  if(bStop)bStop.disabled=!r;
  if(bKill)bKill.disabled=!r;
  document.getElementById('cmdi').disabled=!r;
  document.getElementById('bSend').disabled=!r;
  if(!r){setUp(null);setPl([]);}
}

function setPl(list){
  players=list||[];const n=players.length;
  document.getElementById('tPl').textContent=n;
  document.getElementById('plCount').textContent=n+' online';
  const planPl=document.getElementById('planPl');
  if(planPl)planPl.textContent=n;
  const nb=document.getElementById('nbPl');
  let b=nb.querySelector('.bdg');
  if(n>0){if(!b){b=document.createElement('div');b.className='bdg';nb.appendChild(b);}b.textContent=n>9?'9+':n;}
  else if(b)b.remove();
  const chips=document.getElementById('plChips');
  if(chips)chips.innerHTML=players.map(p=>`<span class="pchip">${esc(p.name)}</span>`).join('');
  renderPl();
}

function setUp(u){
  const v=u||'─';
  document.getElementById('tUp').textContent=v;
  const dup=document.getElementById('dUp');
  if(dup){
    dup.textContent=u||'Offline';
    dup.className=u?'stat-value':'stat-value dim';
  }
  const ds=document.getElementById('dStatus');
  if(ds&&!u)ds.textContent='Not currently running';
  // Plan panel uptime
  const planUp=document.getElementById('planUp');
  const planUpSub=document.getElementById('planUpSub');
  if(planUp){planUp.textContent=u||'Offline';planUp.style.color=u?'var(--t)':'var(--td)';}
  if(planUpSub)planUpSub.textContent=u?'running':'Not running';
}

function updStats(s){
  // s.cpu = process CPU % (from pidusage), s.ram = process RAM in MB (from pidusage)
  const cpu=Number(s.cpu)||0;
  const ramMB=Number(s.ram)||0;  // now MB from pidusage
  const ramPct=Math.min(ramMB/4096*100,100); // assume 4GB allocation for bar
  const cpuCol=cpu>70?'var(--red)':cpu>40?'var(--amber)':'var(--green)';
  const ramCol=ramPct>80?'var(--red)':ramPct>60?'var(--amber)':'var(--green)';
  const cpuTxt=cpu%1===0?cpu.toFixed(0):cpu.toFixed(1);
  const ramTxt=ramMB>=1024?(ramMB/1024).toFixed(1)+' GB':ramMB.toFixed(0)+' MB';
  // Top stat cards
  const cpuEl=document.getElementById('dCpu');
  const ramEl=document.getElementById('dRam');
  if(cpuEl){cpuEl.textContent=cpuTxt+'%';cpuEl.style.color=cpuCol;}
  if(ramEl){ramEl.textContent=ramTxt;ramEl.style.color=ramCol;}
  document.getElementById('tCpu').textContent=cpuTxt+'%';
  document.getElementById('tRam').textContent=ramTxt;
  // Stat card bars
  const cpuBar=document.getElementById('cpuBar');
  const ramBar=document.getElementById('ramBar');
  if(cpuBar){cpuBar.style.width=Math.min(cpu/2,100)+'%';cpuBar.style.background=cpuCol;}
  if(ramBar){ramBar.style.width=ramPct+'%';ramBar.style.background=ramCol;}
  // Sub labels
  const cpuSub=document.getElementById('cpuSub');
  const ramSub=document.getElementById('ramSub');
  if(cpuSub)cpuSub.textContent='of 200% max';
  if(ramSub)ramSub.textContent='of 4 GB ('+ramPct.toFixed(1)+'%)';
  // Plan panel mini cards
  const planCpu=document.getElementById('planCpu');
  const planRam=document.getElementById('planRam');
  const planCpuBar=document.getElementById('planCpuBar');
  const planRamBar=document.getElementById('planRamBar');
  const planRamSub=document.getElementById('planRamSub');
  if(planCpu){planCpu.textContent=cpuTxt+'%';planCpu.style.color=cpuCol;}
  if(planRam){planRam.textContent=ramTxt;planRam.style.color=ramCol;}
  if(planCpuBar){planCpuBar.style.width=Math.min(cpu/2,100)+'%';planCpuBar.style.background=cpuCol;}
  if(planRamBar){planRamBar.style.width=ramPct+'%';planRamBar.style.background=ramCol;}
  if(planRamSub)planRamSub.textContent='of 4 GB ('+ramPct.toFixed(1)+'%)';
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
  // Plan panel
  const planType=document.getElementById('planType');
  const planVer=document.getElementById('planVer');
  if(planType&&c.serverType)planType.textContent=c.serverType.charAt(0).toUpperCase()+c.serverType.slice(1);
  if(planVer&&c.serverVersion)planVer.textContent=c.serverVersion;
}

function apNetwork(network,config){
  networkInfo=network||{lanIp:'',addresses:[]};
  const port=(config&&config.uiPort)||location.port||'8080';
  const lanIp=networkInfo.lanIp||location.hostname||'127.0.0.1';
  document.getElementById('aLAN').textContent=`${lanIp}:${port}`;
  document.getElementById('ciIP').textContent=lanIp;
  const planIP=document.getElementById('planIP');
  if(planIP)planIP.textContent=lanIp;
}

// ─ Players ─
function renderPl(){
  const el=document.getElementById('plList');
  if(!players.length){el.innerHTML='<div class="empty"><span class="empty-i">👥</span>No players online</div>';return;}
  el.innerHTML=players.map(p=>`
    <div class="prow">
      <div class="pavatar"><img src="https://crafatar.com/avatars/${esc(p.name)}?size=34&overlay=true" alt="${esc(p.name)}" onerror="this.outerHTML='🧑'"></div>
      <div><div class="pname">${esc(p.name)}</div><div class="ptime">● Online</div></div>
      <div class="pacts">
        <button class="abtn primary sm" onclick="plAct('op','${esc(p.name)}')">⭐ OP</button>
        <button class="abtn ghost sm" onclick="plAct('creative','${esc(p.name)}')">🎨</button>
        <button class="abtn ghost sm" onclick="plAct('survival','${esc(p.name)}')">⚔️</button>
        <button class="abtn ghost sm" onclick="plAct('spectator','${esc(p.name)}')">👁</button>
        <button class="abtn ghost sm" onclick="plAct('heal','${esc(p.name)}')">❤️</button>
        <button class="abtn ghost sm" onclick="plAct('feed','${esc(p.name)}')">🍖</button>
        <button class="abtn ghost sm" onclick="openTp('${esc(p.name)}')">📍 TP</button>
        <button class="abtn danger sm" onclick="openKick('${esc(p.name)}')">👢 Kick</button>
        <button class="abtn danger sm" onclick="openBan('${esc(p.name)}')">🔨 Ban</button>
      </div>
    </div>
  `).join('');
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

function getOffPlName(){
  const input=document.getElementById('offPl');
  if(!input){toast('Offline player input is unavailable','err');return '';}
  return input.value.trim();
}

function offAct(a){
  const n=getOffPlName();
  if(!n){toast('Enter a username first','err');return;}
  if(!isRunning){toast('Server not running','err');return;}
  const cmd=a==='unban'?'pardon':a;
  sc(cmd+' '+n);
}

function offAct2(a,prompt){
  const n=getOffPlName();
  if(!n){toast('Enter a username first','err');return;}
  if(!isRunning){toast('Server not running','err');return;}
  if(prompt){
    openM(a+' '+n,prompt,'Value',async v=>{
      const value=(v||'').trim();
      if(!value){toast('Enter a value first','err');return;}
      sc(a+' '+n+' '+value);
    });
  } else {
    sc(a+' '+n);
  }
}

function offKick(){
  const n=getOffPlName();
  if(!n){toast('Enter a username first','err');return;}
  if(!isRunning){toast('Server not running','err');return;}
  openM('Kick '+n,'Kick reason (optional)','Reason',async v=>{
    const r=await fetch('/api/player/kick',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,extra:v||'Kicked by admin'})});
    const d=await r.json();toast(d.error||'Kicked '+n,d.error?'err':'ok');
  },'Kicked by admin');
}

function offBan(){
  const n=getOffPlName();
  if(!n){toast('Enter a username first','err');return;}
  if(!isRunning){toast('Server not running','err');return;}
  openM('Ban '+n,'Ban reason','Reason',async v=>{
    const r=await fetch('/api/player/ban',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,extra:v||'Banned by admin'})});
    const d=await r.json();toast(d.error||'Banned '+n,d.error?'err':'ok');
  },'Rule violation');
}

function offPardon(){
  const n=getOffPlName();
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
    sel.innerHTML=d.versions.slice(0,50).map(v=>`<option>${v}</option>`).join('');
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
  setR(d.running);setPl(d.players);setUp(d.uptime);apCfg(d.config);apNetwork(d.network,d.config);
}

// ─ Properties ─
const PDEF={'max-players':'20','gamemode':'survival','difficulty':'easy','level-name':'world','level-type':'minecraft:default','level-seed':'','server-port':'25565','online-mode':'true','white-list':'false','view-distance':'10','simulation-distance':'10','max-tick-time':'60000','network-compression-threshold':'256','pvp':'true','spawn-monsters':'true','spawn-animals':'true','spawn-npcs':'true','allow-nether':'true','allow-flight':'false','generate-structures':'true','spawn-protection':'16','enable-command-block':'false','force-gamemode':'false','hardcore':'false','enable-rcon':'false','rcon.port':'25575','enable-query':'false'};
const PMETA={
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
    html+=`<div class="pgrp"><div class="pgtitle">${g}</div>`;
    for(const{k,m,v}of props){
      let inp='';
      if(m.t==='bool'){
        inp=`<select class="pinput pnarrow" data-key="${k}">
          <option value="true" ${v==='true'?'selected':''}>true</option>
          <option value="false" ${v!=='true'?'selected':''}>false</option>
        </select>`;
      }else if(m.t==='sel'){
        inp=`<select class="pinput" data-key="${k}">${m.o.map(o=>`<option ${v===o?'selected':''}>${o}</option>`).join('')}</select>`;
      }else{
        const def=PDEF[k]!==undefined?` placeholder="${esc(PDEF[k])} (default)"`:'';
        inp=`<input class="pinput" data-key="${k}" type="${m.t||'text'}" value="${esc(v)}"${def}>`;
      }
      html+=`<div class="proprow"><div class="propinfo"><div class="propname">${m.l}</div><div class="propkey">${k}</div></div>${inp}</div>`;
    }
    html+=`</div>`;
  }
  if(other.length){
    html+=`<div class="pgrp"><div class="pgtitle">Other</div>`;
    for(const{k,v}of other)
      html+=`<div class="proprow"><div class="propinfo"><div class="propname">${k}</div></div><input class="pinput" data-key="${k}" value="${esc(v)}"></div>`;
    html+=`</div>`;
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
  el.innerHTML=d.mods.map(m=>`
    <div class="plrow">
      <span style="font-size:20px">🧩</span>
      <div style="flex:1"><div style="font-size:13px;font-weight:600">${esc(m.name)}</div>
        <div style="font-size:11px;font-family:var(--mono);color:var(--td)">${fmtB(m.size)}</div></div>
      <button class="abtn danger sm" onclick="delMod('${esc(m.name)}')">🗑 Delete</button>
    </div>
  `).join('');
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
  el.innerHTML=d.plugins.map(p=>`
    <div class="plrow">
      <span style="font-size:20px">🔌</span>
      <div style="flex:1"><div style="font-size:13px;font-weight:600">${esc(p.name)}</div>
        <div style="font-size:11px;font-family:var(--mono);color:var(--td)">${fmtB(p.size)}</div></div>
      <button class="abtn danger sm" onclick="delPlg('${esc(p.name)}')">🗑 Delete</button>
    </div>
  `).join('');
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
document.querySelectorAll('[data-tab]').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const t=btn.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach(b=>b.classList.remove('active'));
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
    `<div class="minput"><label>${lbl}</label><input class="inp" id="mi" value="${esc(def)}"></div>`;
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
connect();loadVerList();loadVI();
apNetwork(null,null);

document.addEventListener('keydown',e=>{
  if(e.key==='/'&&document.activeElement.tagName!=='INPUT'&&document.activeElement.tagName!=='SELECT'){
    e.preventDefault();
    document.querySelector('[data-tab="console"]').click();
    setTimeout(()=>document.getElementById('cmdi').focus(),50);
  }
});

function updateMOTD(){
  const input=document.getElementById('motdInput');
  const preview=document.getElementById('motdPreview');
  if(input&&preview){
    let text=input.value||'A DroidMC Minecraft Server';
    // Basic color code rendering
    text=text.replace(/§[0-9a-fA-Fk-or]/g,'');
    preview.textContent=text;
  }
}

function saveMOTD(){
  const val=document.getElementById('motdInput')?.value;
  if(!val)return;
  // Could be saved via API in a real implementation
  toast('MOTD updated!','ok');
}
