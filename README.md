# MC Control v2

Minecraft server control panel for Termux (Android).

Runs a local web UI to manage a Java Edition server directly from your
phone.

------------------------------------------------------------------------

## Install

Run inside Termux:

``` bash
curl -fsSL https://raw.githubusercontent.com/loaf1ms/mc-control/main/setup.sh | bash
```

Start the panel:

``` bash
~/start-mc.sh        # foreground (shows live logs)
~/start-mc-bg.sh     # background (tmux session)
```

Open in browser:

http://localhost:8080

or from the same WiFi network:

http://your_phone_ip:8080

------------------------------------------------------------------------

## Requirements

-   Android device
-   Termux
-   OpenJDK 21
-   Node.js
-   2GB+ RAM recommended

The setup script installs required packages automatically.

------------------------------------------------------------------------

## Features

### Server Control

-   Start / Stop / Force kill
-   Live console log streaming
-   Send commands
-   Uptime tracking
-   Auto-accepts EULA

The server runs as a spawned Java process managed by the panel.

------------------------------------------------------------------------

### Version Manager

Download server software directly from official sources:

-   Paper
-   Vanilla
-   Fabric

Downloaded versions are saved as `server.jar`.\
Fabric installs `fabric-server-launch.jar` automatically.

------------------------------------------------------------------------

### Player Management

-   Real-time join/leave tracking
-   Kick / Ban / Unban
-   OP / DeOP
-   Gamemode switching
-   Teleport
-   Heal / Feed
-   Kill
-   Broadcast messages
-   Whitelist commands

Player events are parsed directly from server log output.

------------------------------------------------------------------------

### Plugins & Mods

-   Upload `.jar` files
-   Delete plugins
-   Delete mods
-   Lists installed files and sizes

Directories:

\~/minecraft/plugins/ \~/minecraft/mods/

------------------------------------------------------------------------

### Server Properties Editor

Reads and writes `server.properties`.

-   Updates existing keys
-   Adds new keys
-   Preserves existing file structure where possible

------------------------------------------------------------------------

### System Monitoring

Displays:

-   CPU usage
-   RAM usage
-   Online player count
-   Uptime

Stats update every second.

------------------------------------------------------------------------

## File Structure

\~/mc-control/ server.js package.json config.json

\~/minecraft/ server.jar eula.txt server.properties plugins/ mods/

\~/start-mc.sh \~/start-mc-bg.sh

------------------------------------------------------------------------

## Security

The panel binds to 0.0.0.0 and is accessible on your local network.

There is no authentication system. Do not port forward unless you
understand the risks.

------------------------------------------------------------------------

## Notes

Designed for small servers (friends / LAN use). Keep your phone plugged
in while the server runs.
