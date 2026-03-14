#!/data/data/com.termux/files/usr/bin/bash
# DroidMC setup script for Termux

set -e

G='\033[0;32m'
A='\033[1;33m'
R='\033[0;31m'
B='\033[0;34m'
D='\033[2m'
N='\033[0m'

log()  { echo -e "${G}[OK]${N} $1"; }
warn() { echo -e "${A}[!]${N} $1"; }
err()  { echo -e "${R}[X]${N} $1"; exit 1; }
info() { echo -e "${B}[i]${N} $1"; }
step() {
  echo ""
  echo -e "${G}----------------------------------------${N}"
  echo -e "  $1"
  echo -e "${G}----------------------------------------${N}"
}

clear
echo ""
echo -e "${G}  DroidMC Setup${N}"
echo -e "${D}  Minecraft server panel for Termux${N}"
echo ""

if [ ! -d "/data/data/com.termux" ]; then
  warn "This does not look like Termux."
  read -p "  Continue anyway? [y/N]: " cont
  [[ "$cont" != "y" && "$cont" != "Y" ]] && exit 1
fi

DROIDMC_VERSION="2.1.0"
REPO_RAW="https://raw.githubusercontent.com/loaf1ms/DroidMC/main"
UI_DIR_EARLY="$HOME/DroidMC"

# ── Version / existing install check ────────────────────────────────────────
if [ -f "$UI_DIR_EARLY/.version" ]; then
  INSTALLED_VER="$(cat "$UI_DIR_EARLY/.version")"
  echo ""
  echo -e "  ${A}DroidMC $INSTALLED_VER is already installed.${N}"
  echo ""
  echo -e "  ${D}[1]${N} Reinstall (overwrite panel files, keep world data)"
  echo -e "  ${D}[2]${N} Cancel"
  echo ""
  read -p "  Choice [1/2]: " install_choice
  if [[ "$install_choice" != "1" ]]; then
    info "Cancelled. Run ~/start-mc.sh to launch, or rerun setup.sh to update."
    exit 0
  fi
  warn "Reinstalling DroidMC $DROIDMC_VERSION over $INSTALLED_VER..."
fi

step "Downloading DroidMC files"

mkdir -p "$UI_DIR_EARLY/public"

info "Downloading server.js..."
curl -fsSL "$REPO_RAW/server.js" -o "$UI_DIR_EARLY/server.js" || err "Failed to download server.js"
info "Downloading package.json..."
curl -fsSL "$REPO_RAW/package.json" -o "$UI_DIR_EARLY/package.json" || err "Failed to download package.json"
info "Downloading UI files..."
curl -fsSL "$REPO_RAW/index.html" -o "$UI_DIR_EARLY/public/index.html" || err "Failed to download index.html"
curl -fsSL "$REPO_RAW/style.css" -o "$UI_DIR_EARLY/public/style.css" || err "Failed to download style.css"
curl -fsSL "$REPO_RAW/app.js" -o "$UI_DIR_EARLY/public/app.js" || err "Failed to download app.js"
info "Downloading uninstall.sh..."
curl -fsSL "$REPO_RAW/uninstall.sh" -o "$HOME/uninstall-mc.sh" || warn "Failed to download uninstall.sh (non-fatal)"
chmod +x "$HOME/uninstall-mc.sh" 2>/dev/null || true
log "Files downloaded to ~/DroidMC/"

# ── Checksum verification ────────────────────────────────────────────────────
info "Verifying file integrity..."
CHECKSUM_FILE="$UI_DIR_EARLY/.checksums"
curl -fsSL "$REPO_RAW/checksums.sha256" -o "$CHECKSUM_FILE" 2>/dev/null || {
  warn "checksums.sha256 not found in repo — skipping verification."
  CHECKSUM_FILE=""
}

if [ -n "$CHECKSUM_FILE" ] && command -v sha256sum >/dev/null 2>&1; then
  FAIL=0
  while IFS="  " read -r expected_hash filename; do
    [ -z "$filename" ] && continue
    filepath="$UI_DIR_EARLY/$filename"
    actual_hash="$(sha256sum "$filepath" 2>/dev/null | awk '{print $1}')"
    if [ "$actual_hash" != "$expected_hash" ]; then
      warn "Checksum mismatch: $filename"
      FAIL=1
    fi
  done < "$CHECKSUM_FILE"
  if [ "$FAIL" -eq 1 ]; then
    err "One or more files failed verification. The download may be corrupted. Aborting."
  fi
  log "All files verified OK"
else
  [ -z "$CHECKSUM_FILE" ] || warn "sha256sum not available — skipping verification."
fi

step "Step 1/5 - Installing packages"

info "Updating package lists..."
pkg update -y 2>/dev/null || warn "pkg update had warnings"

info "Installing OpenJDK 21..."
pkg install -y openjdk-21 || err "Failed to install Java"
log "Java ready: $(java -version 2>&1 | head -1)"

info "Installing Node.js..."
pkg install -y nodejs || err "Failed to install Node.js"
log "Node.js $(node --version) / npm $(npm --version)"

pkg install -y curl 2>/dev/null || true

step "Step 2/5 - Android phantom process killer"

echo ""
echo -e "  ${A}IMPORTANT:${N} Android 12+ may kill background processes."
echo -e "  ${G}termux-wake-lock${N} helps keep Termux alive."
echo ""

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  log "Wake lock enabled"
else
  warn "termux-wake-lock not available."
  warn "Install Termux:API from F-Droid, then run: pkg install termux-api"
fi

echo ""
read -p "  Install tmux? Lets server keep running if you close Termux [Y/n]: " dotmux
if [[ "$dotmux" != "n" && "$dotmux" != "N" ]]; then
  pkg install -y tmux
  log "tmux installed"
else
  info "Skipping tmux"
fi

# ── RAM prompt ───────────────────────────────────────────────────────────────
TOTAL_MB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print int($2/1024)}')
if [ -n "$TOTAL_MB" ] && [ "$TOTAL_MB" -gt 0 ]; then
  SUGGESTED_MB=$((TOTAL_MB / 2))
  SUGGESTED_MB=$(( (SUGGESTED_MB / 512) * 512 ))
  [ "$SUGGESTED_MB" -lt 512 ] && SUGGESTED_MB=512
  SUGGESTED="${SUGGESTED_MB}M"
  info "Detected ${TOTAL_MB}MB total RAM. Suggested allocation: ${SUGGESTED}"
else
  SUGGESTED="1G"
  info "Could not detect RAM. Suggested default: $SUGGESTED"
fi
echo ""
read -p "  How much RAM for the Minecraft server? [default: $SUGGESTED]: " ram_input
ram_input="${ram_input:-$SUGGESTED}"
if [[ "$ram_input" =~ ^[0-9]+[MmGg]$ ]]; then
  MC_RAM="${ram_input^^}"
  log "Server RAM set to $MC_RAM"
else
  warn "Invalid format '$ram_input', falling back to $SUGGESTED"
  MC_RAM="${SUGGESTED^^}"
fi

step "Step 3/5 - Setting up directories"

MC_DIR="$HOME/minecraft"
UI_DIR="$HOME/DroidMC"
mkdir -p "$MC_DIR" "$UI_DIR"
log "Server folder: $MC_DIR"
log "Panel folder:  $UI_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$SCRIPT_DIR" = "$UI_DIR" ]; then
  log "server.js already in place"
elif [ -f "$SCRIPT_DIR/server.js" ]; then
  cp "$SCRIPT_DIR/server.js" "$UI_DIR/server.js"
  log "Copied server.js to $UI_DIR/server.js"
elif [ -f "$UI_DIR/server.js" ]; then
  log "server.js already in place"
else
  warn "server.js not found next to this script."
fi

cat > "$UI_DIR/package.json" << 'PKGJSON'
{
  "name": "DroidMC",
  "version": "2.0.0",
  "description": "Minecraft Server Panel for Termux",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.16.0",
    "pidusage": "^3.0.2"
  }
}
PKGJSON
log "package.json written"

echo ""
echo -e "  ${A}Minecraft End User License Agreement (EULA)${N}"
echo -e "  By running a Minecraft server you agree to Mojang's EULA:"
echo -e "  ${B}https://aka.ms/MinecraftEULA${N}"
echo ""
read -p "  Do you accept the Minecraft EULA? [Y/n]: " eula_ans
if [[ "$eula_ans" == "n" || "$eula_ans" == "N" ]]; then
  warn "EULA not accepted. Cleaning up and exiting."
  rm -rf "$UI_DIR" "$MC_DIR" "$HOME/start-mc.sh" "$HOME/start-mc-bg.sh" 2>/dev/null || true
  exit 1
fi
echo "eula=true" > "$MC_DIR/eula.txt"
log "EULA accepted"

step "Step 4/5 - Installing Node.js dependencies"

cd "$UI_DIR"
npm install
log "express + ws installed"

# Write version marker
echo "$DROIDMC_VERSION" > "$UI_DIR/.version"
log "Version $DROIDMC_VERSION recorded"

step "Step 5/5 - Creating launch scripts"

cat > "$HOME/start-mc.sh" << STARTSCRIPT
#!/data/data/com.termux/files/usr/bin/bash
# DroidMC launch script

MC_RAM="$MC_RAM"
MC_DIR="$MC_DIR"
UI_PORT="8080"
MC_VERBOSE="1"

command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

LOCAL_IP=\$(hostname -I 2>/dev/null | awk '{print \$1}')

echo ""
echo "  DroidMC starting..."
echo "  Browser (this phone):  http://localhost:\$UI_PORT"
[ -n "\$LOCAL_IP" ] && echo "  Browser (same WiFi):   http://\$LOCAL_IP:\$UI_PORT"
echo "  Use the Version tab to download a server JAR if needed."
echo ""

cd "$UI_DIR"
MC_DIR="\$MC_DIR" MC_RAM="\$MC_RAM" UI_PORT="\$UI_PORT" MC_VERBOSE="\$MC_VERBOSE" node server.js
STARTSCRIPT
chmod +x "$HOME/start-mc.sh"
log "Created ~/start-mc.sh"

if command -v tmux >/dev/null 2>&1; then
  cat > "$HOME/start-mc-bg.sh" << BGSCRIPT
#!/data/data/com.termux/files/usr/bin/bash
# DroidMC background mode (tmux)

MC_RAM="$MC_RAM"
MC_DIR="$MC_DIR"
UI_PORT="8080"

command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

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
  echo "  DroidMC started in background (tmux: mc)"
  echo "  Browser (this phone): http://localhost:\$UI_PORT"
  [ -n "\$LOCAL_IP" ] && echo "  Browser (WiFi):       http://\$LOCAL_IP:\$UI_PORT"
  echo ""
  echo "  Re-attach:  tmux attach -t mc"
  echo "  Kill:       tmux kill-session -t mc"
  echo ""
fi
BGSCRIPT
  chmod +x "$HOME/start-mc-bg.sh"
  log "Created ~/start-mc-bg.sh"
fi

echo ""
echo -e "${G}==============================================${N}"
echo -e "${G}  Setup complete${N}"
echo -e "${G}==============================================${N}"
echo ""
echo -e "  ${A}TIP: Keep your phone plugged in while the server runs.${N}"
echo ""

rm -f "$0"