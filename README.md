# MC Control — by loaf1ms

Aternos-style Minecraft server panel that runs directly on your Android phone via Termux. Control your server from any browser on the same WiFi.

[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?style=flat&logo=discord&logoColor=white)](https://discord.gg/u6tE8DzS5V)

---

## Install

Paste this in Termux:

```bash
curl -fsSL https://raw.githubusercontent.com/loaf1ms/mc-control/main/setup.sh -o setup.sh
bash setup.sh
```

The script will walk you through setup and configure everything automatically.

Then start the panel:

```bash
~/start-mc.sh        # foreground (shows live logs in terminal)
~/start-mc-bg.sh     # background via tmux (recommended)
```

Open in your browser: `http://your_phones_ip:8080`  
Or on the same device: `http://localhost:8080`

---

## Features

- **Server control** — Start, stop, force kill
- **Live console** — Stream logs in real time, send commands
- **Version manager** — Download Paper, Vanilla, or Fabric directly from official sources
- **Player management** — Kick, ban, unban, OP, gamemode, teleport, heal, feed
- **Plugins & Mods** — Upload and delete `.jar` files
- **Properties editor** — Edit `server.properties` from the browser
- **System stats** — Live CPU and RAM usage with ring gauges
- **How to Connect card** — Shows your IP, port, server type and version at a glance

---

## Requirements

- Android device running Termux
- 2GB+ RAM recommended (4GB+ for a smooth experience)

The setup script automatically installs OpenJDK 21, Node.js, and tmux.

---

## Tips

- Keep your phone **plugged in** while the server runs — Java is heavy on battery
- Run `termux-wake-lock` (requires Termux:API from F-Droid) to prevent Android from killing the server
- Use **Paper** over Vanilla for much better performance on ARM
- Set `view-distance=6` in Properties if the server feels slow

---

## File Structure

```
~/mc-control/       ← panel files (server.js, config.json)
~/minecraft/        ← server files (server.jar, worlds, plugins, mods)
~/start-mc.sh       ← foreground launcher
~/start-mc-bg.sh    ← background launcher (tmux)
```

---

## Security

The panel binds to `0.0.0.0` and is accessible on your local network. There is no authentication — do not port forward unless you know what you're doing.
