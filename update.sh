#!/data/data/com.termux/files/usr/bin/bash
# DroidMC update script

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

REPO_RAW="https://raw.githubusercontent.com/loaf1ms/DroidMC/main"
UI_DIR="$HOME/DroidMC"

clear
echo ""
echo -e "${G}  DroidMC Update${N}"
echo -e "${D}  Pulls the latest panel files from GitHub${N}"
echo ""

# ── Check installed ──────────────────────────────────────────────────────────
if [ ! -d "$UI_DIR" ]; then
  err "DroidMC is not installed. Run setup.sh first."
fi

INSTALLED_VER="(unknown)"
[ -f "$UI_DIR/.version" ] && INSTALLED_VER="$(cat "$UI_DIR/.version")"
info "Installed version: $INSTALLED_VER"

# ── Fetch remote version ─────────────────────────────────────────────────────
info "Checking latest version..."
REMOTE_VER="$(curl -fsSL "$REPO_RAW/.version" 2>/dev/null)" || {
  warn "Could not fetch remote version — proceeding anyway."
  REMOTE_VER="unknown"
}

if [ "$REMOTE_VER" != "unknown" ] && [ "$REMOTE_VER" = "$INSTALLED_VER" ]; then
  echo ""
  echo -e "  ${G}You're already on the latest version ($INSTALLED_VER).${N}"
  echo ""
  read -p "  Force re-download anyway? [y/N]: " force
  [[ "$force" != "y" && "$force" != "Y" ]] && { info "Nothing to do."; exit 0; }
else
  [ "$REMOTE_VER" != "unknown" ] && info "Latest version:    $REMOTE_VER"
fi

# ── Stop running instance ────────────────────────────────────────────────────
WAS_RUNNING=0
if command -v tmux >/dev/null 2>&1 && tmux has-session -t mc 2>/dev/null; then
  warn "DroidMC is currently running."
  read -p "  Stop it to apply the update? [Y/n]: " stop_ans
  if [[ "$stop_ans" == "n" || "$stop_ans" == "N" ]]; then
    info "Update cancelled. Stop DroidMC first, then run update.sh again."
    exit 0
  fi
  tmux kill-session -t mc
  log "Stopped tmux session 'mc'"
  WAS_RUNNING=1
fi

step "Backing up current panel files"

BACKUP_DIR="$UI_DIR/.backup"
mkdir -p "$BACKUP_DIR"
cp "$UI_DIR/server.js"         "$BACKUP_DIR/server.js"         2>/dev/null || true
cp "$UI_DIR/public/index.html" "$BACKUP_DIR/index.html"        2>/dev/null || true
cp "$UI_DIR/public/style.css"  "$BACKUP_DIR/style.css"         2>/dev/null || true
cp "$UI_DIR/public/app.js"     "$BACKUP_DIR/app.js"            2>/dev/null || true
log "Backed up to ~/DroidMC/.backup/"

step "Downloading latest files"

mkdir -p "$UI_DIR/public"

download() {
  local name="$1"
  local dest="$2"
  info "Downloading $name..."
  curl -fsSL "$REPO_RAW/$name" -o "$dest" || {
    warn "Failed to download $name — restoring backup."
    cp "$BACKUP_DIR/$(basename "$dest")" "$dest" 2>/dev/null || true
    err "Update failed on $name."
  }
}

download "server.js"        "$UI_DIR/server.js"
download "index.html"       "$UI_DIR/public/index.html"
download "style.css"        "$UI_DIR/public/style.css"
download "app.js"           "$UI_DIR/public/app.js"
log "Files downloaded"

# ── Checksum verification ────────────────────────────────────────────────────
info "Verifying file integrity..."
CHECKSUM_FILE="$UI_DIR/.checksums"
curl -fsSL "$REPO_RAW/checksums.sha256" -o "$CHECKSUM_FILE" 2>/dev/null || {
  warn "checksums.sha256 not found in repo — skipping verification."
  CHECKSUM_FILE=""
}

if [ -n "$CHECKSUM_FILE" ] && command -v sha256sum >/dev/null 2>&1; then
  FAIL=0
  while IFS="  " read -r expected_hash filename; do
    [ -z "$filename" ] && continue
    filepath="$UI_DIR/$filename"
    actual_hash="$(sha256sum "$filepath" 2>/dev/null | awk '{print $1}')"
    if [ "$actual_hash" != "$expected_hash" ]; then
      warn "Checksum mismatch: $filename"
      FAIL=1
    fi
  done < "$CHECKSUM_FILE"

  if [ "$FAIL" -eq 1 ]; then
    warn "Verification failed — restoring backup."
    cp "$BACKUP_DIR/server.js"   "$UI_DIR/server.js"          2>/dev/null || true
    cp "$BACKUP_DIR/index.html"  "$UI_DIR/public/index.html"  2>/dev/null || true
    cp "$BACKUP_DIR/style.css"   "$UI_DIR/public/style.css"   2>/dev/null || true
    cp "$BACKUP_DIR/app.js"      "$UI_DIR/public/app.js"      2>/dev/null || true
    err "Update aborted. Your previous version has been restored."
  fi
  log "All files verified OK"
else
  [ -z "$CHECKSUM_FILE" ] || warn "sha256sum not available — skipping verification."
fi

step "Updating Node.js dependencies"
cd "$UI_DIR"
npm install
log "Dependencies up to date"

# ── Write new version ────────────────────────────────────────────────────────
[ "$REMOTE_VER" != "unknown" ] && echo "$REMOTE_VER" > "$UI_DIR/.version"
log "Version updated to ${REMOTE_VER}"

echo ""
echo -e "${G}==============================================${N}"
echo -e "${G}  Update complete${N}"
if [ "$INSTALLED_VER" != "unknown" ] && [ "$REMOTE_VER" != "unknown" ]; then
  echo -e "${G}  $INSTALLED_VER  →  $REMOTE_VER${N}"
fi
echo -e "${G}==============================================${N}"
echo ""

# ── Optionally restart ───────────────────────────────────────────────────────
if [ "$WAS_RUNNING" -eq 1 ] && command -v tmux >/dev/null 2>&1; then
  read -p "  Restart DroidMC now? [Y/n]: " restart_ans
  if [[ "$restart_ans" != "n" && "$restart_ans" != "N" ]]; then
    bash "$HOME/start-mc-bg.sh"
  else
    echo -e "  Run ${G}~/start-mc-bg.sh${N} when ready."
    echo ""
  fi
else
  echo -e "  Run ${G}~/start-mc.sh${N} to launch."
  echo ""
fi