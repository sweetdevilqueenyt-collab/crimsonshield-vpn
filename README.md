# CrimsonShield VPN — Windows client

Open-source Windows app for [CrimsonShield VPN](https://crimsonvpn.netlify.app).
Log in with a license key, pick a server, connect. Encryption is done by the official
[WireGuard](https://www.wireguard.com/) driver; this app manages the tunnel.

**Download:** [latest release](https://github.com/sweetdevilqueenyt-collab/crimsonshield-vpn/releases/latest)

## Features
- One-click connect to WireGuard servers (US, UK, Australia)
- Kill switch, split tunneling, DNS choice, alternate ports (443/53)
- Share VPN with a console (Wi-Fi hotspot or Ethernet)
- Smart DNS registration for consoles and TVs
- Private key generated and stored locally (Windows DPAPI), never sent to the server

## Build
```bash
npm ci
npm run build        # → dist/CrimsonShield-VPN-Setup.exe
npm start            # dev mode (simulated tunnel on macOS/Linux)
```
Builds for releases are produced by GitHub Actions (`.github/workflows/build.yml`).

## Code signing
Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## Privacy
The app sends only: your license key (to log in), your device's WireGuard **public** key, and your chosen server/settings.
No browsing data, DNS queries or traffic logs are collected. See the servers' no-logs setup in the project docs.

## License
MIT. See [LICENSE](LICENSE). Bundled: Electron (MIT), flag-icons (MIT), Cinzel font (SIL OFL 1.1).
WireGuard® is a registered trademark of Jason A. Donenfeld; the WireGuard driver is downloaded from wireguard.com at install time.
