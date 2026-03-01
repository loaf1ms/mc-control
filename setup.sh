#!/data/data/com.termux/files/usr/bin/bash
# ╔══════════════════════════════════════════════════════════╗
# ║            DroidMC — Termux Setup Script                 ║
# ║         Minecraft server panel for Android               ║
# ╚══════════════════════════════════════════════════════════╝

set -e
G='\033[0;32m'   # green
A='\033[1;33m'   # amber
R='\033[0;31m'   # red
B='\033[0;34m'   # blue
D='\033[2m'      # dim
N='\033[0m'      # reset

log()  { echo -e "${G}[✓]${N} $1"; }
warn() { echo -e "${A}[!]${N} $1"; }
err()  { echo -e "${R}[✗]${N} $1"; exit 1; }
info() { echo -e "${B}[i]${N} $1"; }
step() {
  echo ""
  echo -e "${G}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo -e "  $1"
  echo -e "${G}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
}

clear
echo ""
echo -e "${G}  🤖  DroidMC — Setup${N}"
echo -e "${D}  Full Minecraft server panel for Termux${N}"
echo ""

# ── Sanity check: are we in Termux? ──────────────────────────────────────────
if [ ! -d "/data/data/com.termux" ]; then
  warn "This doesn't look like Termux. This script is designed for Termux on Android."
  read -p "  Continue anyway? [y/N]: " cont
  [[ "$cont" != "y" && "$cont" != "Y" ]] && exit 1
fi

# ── Download project files from GitHub ───────────────────────────────────────
step "Downloading DroidMC files"

REPO_RAW="https://raw.githubusercontent.com/loaf1ms/DroidMC/main"
UI_DIR_EARLY="$HOME/DroidMC"
mkdir -p "$UI_DIR_EARLY"

info "Downloading server.js..."
curl -fsSL "$REPO_RAW/server.js"    -o "$UI_DIR_EARLY/server.js"    || err "Failed to download server.js — check your internet connection"
info "Downloading package.json..."
curl -fsSL "$REPO_RAW/package.json" -o "$UI_DIR_EARLY/package.json" || err "Failed to download package.json"
info "Downloading UI files..."
mkdir -p "$UI_DIR_EARLY/public"
curl -fsSL "$REPO_RAW/index.html" -o "$UI_DIR_EARLY/public/index.html" || err "Failed to download index.html"
curl -fsSL "$REPO_RAW/style.css"  -o "$UI_DIR_EARLY/public/style.css"  || err "Failed to download style.css"
curl -fsSL "$REPO_RAW/app.js"     -o "$UI_DIR_EARLY/public/app.js"     || err "Failed to download app.js"
log "Files downloaded to ~/DroidMC/" 

# ── Step 1: Install packages ──────────────────────────────────────────────────
step "Step 1/5 — Installing packages"

info "Updating package lists..."
pkg update -y 2>/dev/null || warn "pkg update had warnings (usually fine)"

info "Installing OpenJDK 21..."
pkg install -y openjdk-21 || err "Failed to install Java. Try running 'pkg update' first."
log "Java ready: $(java -version 2>&1 | head -1)"

info "Installing Node.js..."
pkg install -y nodejs || err "Failed to install Node.js."
log "Node.js $(node --version)  /  npm $(npm --version)"

pkg install -y curl 2>/dev/null || true

# ── Step 2: Phantom process killer fix ───────────────────────────────────────
step "Step 2/5 — Android phantom process killer"

echo ""
echo -e "  ${A}IMPORTANT:${N} Android 12+ has a 'phantom process killer'"
echo -e "  that silently terminates background processes like your MC server."
echo -e "  This is the #1 reason servers randomly die on Android."
echo ""
echo -e "  ${G}termux-wake-lock${N} is the easiest fix — it tells Android"
echo -e "  to keep Termux alive. Requires the Termux:API app from F-Droid."
echo ""

if command -v termux-wake-lock &>/dev/null; then
  termux-wake-lock
  log "Wake lock enabled — Termux won't be suspended while running"
else
  warn "termux-wake-lock not available."
  warn "Install 'Termux:API' from F-Droid, then run: pkg install termux-api"
  warn "Without it, Android may kill your server when the screen turns off."
fi

echo ""
read -p "  Install tmux? Lets server keep running if you close the Termux window [Y/n]: " dotmux
if [[ "$dotmux" != "n" && "$dotmux" != "N" ]]; then
  pkg install -y tmux
  log "tmux installed — you can run the server in the background"
else
  info "Skipping tmux"
fi

MC_RAM="2G"
log "Server RAM defaulted to 2G (change anytime in the Settings tab)"

# ── Step 3: Directories & files ───────────────────────────────────────────────
step "Step 3/5 — Setting up directories"

MC_DIR="$HOME/minecraft"
UI_DIR="$HOME/DroidMC"
mkdir -p "$MC_DIR" "$UI_DIR"
log "Server folder:  $MC_DIR"
log "Panel folder:   $UI_DIR"

# Copy server.js if it's next to this script (and not already in the right place)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$SCRIPT_DIR" = "$UI_DIR" ]; then
  # Already running from inside DroidMC/ — nothing to copy
  log "server.js already in place"
elif [ -f "$SCRIPT_DIR/server.js" ]; then
  cp "$SCRIPT_DIR/server.js" "$UI_DIR/server.js"
  log "server.js → $UI_DIR/server.js"
elif [ -f "$UI_DIR/server.js" ]; then
  log "server.js already in place"
else
  warn "server.js not found next to this script."
  warn "You must copy server.js to $UI_DIR/server.js before starting."
fi

# Write package.json
cat > "$UI_DIR/package.json" << 'PKGJSON'
{
  "name": "DroidMC",
  "version": "2.0.0",
  "description": "Minecraft Server Panel for Termux",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.16.0"
  }
}
PKGJSON
log "package.json written"

# ── EULA ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "  ${A}Minecraft End User License Agreement (EULA)${N}"
echo -e "  By running a Minecraft server you agree to Mojang's EULA:"
echo -e "  ${B}https://aka.ms/MinecraftEULA${N}"
echo ""
read -p "  Do you accept the Minecraft EULA? [Y/n]: " eula_ans
if [[ "$eula_ans" == "n" || "$eula_ans" == "N" ]]; then
  echo ""
  warn "EULA not accepted. Cleaning up and exiting..."
  rm -rf "$UI_DIR" "$MC_DIR" "$HOME/start-mc.sh" "$HOME/start-mc-bg.sh" 2>/dev/null || true
  echo -e "  ${R}Setup cancelled.${N}"
  echo ""
  exit 1
fi
echo "eula=true" > "$MC_DIR/eula.txt"
log "EULA accepted — eula.txt written"

# ── Step 4: Node dependencies ─────────────────────────────────────────────────
step "Step 4/5 — Installing Node.js dependencies"

cd "$UI_DIR"
npm install
log "express + ws installed"

# ── Step 5: Launch scripts ────────────────────────────────────────────────────
step "Step 5/5 — Creating launch scripts"

# Normal start script
cat > "$HOME/start-mc.sh" << STARTSCRIPT
#!/data/data/com.termux/files/usr/bin/bash
# DroidMC — Launch script
# Change MC_RAM below to adjust memory

MC_RAM="$MC_RAM"
MC_DIR="$MC_DIR"
UI_PORT="8080"
MC_VERBOSE="1"   # ← print MC logs live in this terminal (set to 0 to silence)

command -v termux-wake-lock &>/dev/null && termux-wake-lock

LOCAL_IP=\$(hostname -I 2>/dev/null | awk '{print \$1}')

echo ""
echo -e "  🤖  DroidMC starting..."
echo -e "  Browser (this phone):  http://localhost:\$UI_PORT"
[ -n "\$LOCAL_IP" ] && echo -e "  Browser (same WiFi):   http://\$LOCAL_IP:\$UI_PORT"
echo -e "  Use the Version tab to download a server JAR if you haven't yet."
echo -e "  ─────────────────────────────────────────────"
echo -e "  Live server logs will appear below once the server starts."
echo -e "  ─────────────────────────────────────────────"
echo ""

cd "$UI_DIR"
MC_DIR="\$MC_DIR" MC_RAM="\$MC_RAM" UI_PORT="\$UI_PORT" MC_VERBOSE="\$MC_VERBOSE" node server.js
STARTSCRIPT
chmod +x "$HOME/start-mc.sh"
log "Created ~/start-mc.sh"

# Background (tmux) start script
if command -v tmux &>/dev/null; then
  cat > "$HOME/start-mc-bg.sh" << BGSCRIPT
#!/data/data/com.termux/files/usr/bin/bash
# DroidMC — Background mode (tmux)
# Server keeps running even if you close the Termux window

MC_RAM="$MC_RAM"
MC_DIR="$MC_DIR"
UI_PORT="8080"

command -v termux-wake-lock &>/dev/null && termux-wake-lock

if tmux has-session -t mc 2>/dev/null; then
  echo ""
  echo "  DroidMC is already running."
  echo "  Re-attach: tmux attach -t mc"
  echo "  Kill:      tmux kill-session -t mc"
  echo ""
else
  tmux new-session -d -s mc \
    "cd $UI_DIR && MC_DIR='\$MC_DIR' MC_RAM='\$MC_RAM' UI_PORT='\$UI_PORT' node server.js"

  LOCAL_IP=\$(hostname -I 2>/dev/null | awk '{print \$1}')
  echo ""
  echo "  🤖  DroidMC started in background (tmux: mc)"
  echo "  Browser (this phone): http://localhost:\$UI_PORT"
  [ -n "\$LOCAL_IP" ] && echo "  Browser (WiFi):       http://\$LOCAL_IP:\$UI_PORT"
  echo ""
  echo "  Re-attach:  tmux attach -t mc"
  echo "  Kill:       tmux kill-session -t mc"
  echo ""
fi
BGSCRIPT
  chmod +x "$HOME/start-mc-bg.sh"
  log "Created ~/start-mc-bg.sh  (background/tmux mode)"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${G}╔══════════════════════════════════════════════╗${N}"
echo -e "${G}║         ✓  Setup complete!                  ║${N}"
echo -e "${G}╚══════════════════════════════════════════════╝${N}"
echo ""
echo -e "  ${D}Start the panel:${N}"
echo -e "    ${G}~/start-mc.sh${N}           ${D}← normal${N}"
if command -v tmux &>/dev/null; then
echo -e "    ${G}~/start-mc-bg.sh${N}        ${D}← background (recommended)${N}"
fi
echo ""
echo -e "  ${D}Open in your browser:${N}"
echo -e "    ${G}http://localhost:8080${N}"
echo ""
echo -e "  ${A}Keep your phone plugged in while the server runs!${N}"
echo ""