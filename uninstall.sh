#!/data/data/com.termux/files/usr/bin/bash
# DroidMC uninstall script

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

UI_DIR="$HOME/DroidMC"
MC_DIR="$HOME/minecraft"

clear
echo ""
echo -e "${R}  DroidMC Uninstall${N}"
echo -e "${D}  This will remove the DroidMC panel and launch scripts.${N}"
echo ""

# ── Check if installed ───────────────────────────────────────────────────────
if [ ! -d "$UI_DIR" ] && [ ! -f "$HOME/start-mc.sh" ]; then
  warn "DroidMC does not appear to be installed. Nothing to remove."
  exit 0
fi

INSTALLED_VER="(unknown)"
[ -f "$UI_DIR/.version" ] && INSTALLED_VER="$(cat "$UI_DIR/.version")"
info "Found DroidMC $INSTALLED_VER"
echo ""

# ── Stop running instance ────────────────────────────────────────────────────
if command -v tmux >/dev/null 2>&1 && tmux has-session -t mc 2>/dev/null; then
  warn "DroidMC is currently running in a tmux session."
  read -p "  Stop it now and continue? [Y/n]: " stop_ans
  if [[ "$stop_ans" == "n" || "$stop_ans" == "N" ]]; then
    info "Uninstall cancelled. Stop DroidMC first, then run this script again."
    exit 0
  fi
  tmux kill-session -t mc
  log "Stopped tmux session 'mc'"
fi

# ── World data ───────────────────────────────────────────────────────────────
REMOVE_WORLD=0
if [ -d "$MC_DIR" ]; then
  echo ""
  echo -e "  ${A}World data found at ~/minecraft/${N}"
  echo -e "  ${D}[1]${N} Keep world data (safe, just removes the panel)"
  echo -e "  ${D}[2]${N} Delete everything including the world ${R}(cannot be undone)${N}"
  echo ""
  read -p "  Choice [1/2]: " world_choice
  [[ "$world_choice" == "2" ]] && REMOVE_WORLD=1
fi

# ── Final confirmation ───────────────────────────────────────────────────────
echo ""
echo -e "  ${A}About to remove:${N}"
echo -e "    ${D}~/DroidMC/${N}          (panel files)"
echo -e "    ${D}~/start-mc.sh${N}"
echo -e "    ${D}~/start-mc-bg.sh${N}"
[ "$REMOVE_WORLD" -eq 1 ] && echo -e "    ${R}~/minecraft/${N}         (world data — PERMANENT)"
echo ""
read -p "  Are you sure? [y/N]: " confirm
[[ "$confirm" != "y" && "$confirm" != "Y" ]] && { info "Cancelled."; exit 0; }

# ── Remove files ─────────────────────────────────────────────────────────────
echo ""
info "Removing panel files..."
rm -rf "$UI_DIR"
log "Removed ~/DroidMC/"

info "Removing launch scripts..."
rm -f "$HOME/start-mc.sh" "$HOME/start-mc-bg.sh"
log "Removed launch scripts"

if [ "$REMOVE_WORLD" -eq 1 ]; then
  info "Removing world data..."
  rm -rf "$MC_DIR"
  log "Removed ~/minecraft/"
else
  info "World data kept at ~/minecraft/"
fi

# ── Optional: remove packages ────────────────────────────────────────────────
echo ""
read -p "  Remove Node.js and Java (openjdk-21)? [y/N]: " rm_pkgs
if [[ "$rm_pkgs" == "y" || "$rm_pkgs" == "Y" ]]; then
  pkg uninstall -y nodejs openjdk-21 2>/dev/null || warn "Some packages could not be removed"
  log "Packages removed"
else
  info "Packages kept"
fi

echo ""
echo -e "${G}==============================================${N}"
echo -e "${G}  DroidMC uninstalled${N}"
echo -e "${G}==============================================${N}"
echo ""
[ "$REMOVE_WORLD" -eq 0 ] && echo -e "  ${D}Your world is safe at ~/minecraft/${N}"
echo ""