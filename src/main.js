const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, safeStorage, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { createTunnel } = require("./wireguard");
const { createSharing } = require("./sharing");

// ── Config ──
const CONFIG_PATH = app.isPackaged ? path.join(process.resourcesPath, "config.json") : path.join(__dirname, "..", "config.json");
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const DEFAULT_API = String(process.env.CSV_API || CONFIG.apiBase).replace(/\/$/, "");
const apiBase = () => S.apiBase || DEFAULT_API; // can be changed on the login screen
const TUNNEL_NAME = CONFIG.tunnelName || "CrimsonShield";
const tunnel = createTunnel(TUNNEL_NAME);
const sharing = createSharing(TUNNEL_NAME);

if (!app.requestSingleInstanceLock()) app.quit();

// ── Encrypted local state (Windows DPAPI via safeStorage) ──
const STATE_FILE = path.join(app.getPath("userData"), "state.json");
const DEFAULT_SETTINGS = { serverId: null, port: 51820, dns: "cloudflare", split: "full", cidrs: "", killSwitch: true, autoConnect: false, launchAtStartup: false };
const newShare = () => ({
  enabled: false, mode: "hotspot", adapter: "",
  ssid: "CrimsonShield-" + crypto.randomBytes(2).toString("hex").toUpperCase(),
  pass: [...crypto.randomBytes(10)].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join(""),
});
let S = { installId: crypto.randomUUID(), settings: { ...DEFAULT_SETTINGS }, share: newShare() };

const enc = (v) => (v == null ? null : safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(String(v)).toString("base64") : Buffer.from(String(v)).toString("base64"));
const dec = (v) => {
  if (!v) return null;
  try { return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, "base64")) : Buffer.from(v, "base64").toString(); } catch { return null; }
};
function loadState() {
  try { S = { ...S, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; S.settings = { ...DEFAULT_SETTINGS, ...S.settings }; } catch {}
  if (/beamish-fairy-ec18a7/.test(S.apiBase || "")) S.apiBase = null; // site was renamed
  S.share = { ...newShare(), ...(S.share || {}) };
}
function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(S, null, 2));
}

// ── Runtime status pushed to the UI ──
let status = { phase: "disconnected", message: "", ip: null, since: null, stats: null };
let win, tray, cache = { license: null, servers: [], dns: {}, ports: [], brand: {} };
let wantConnected = false, busy = false, watchdogTimer, licenseTimer;
// Console sharing runtime state
let share = { phase: "off", message: "", clients: null, adapters: [], hotspotCapable: null };
let shareTimer;

function push() {
  win?.webContents.send("state", publicState());
  updateTray();
}
function setStatus(patch) { status = { ...status, ...patch }; push(); }

function publicState() {
  return {
    loggedIn: !!S.token,
    status,
    settings: S.settings,
    share: { ...S.share, ...share },
    ...cache,
    deviceName: os.hostname(),
    wireguardInstalled: tunnel.isInstalled(),
    apiBase: apiBase(),
    apiConfigured: !/YOUR-SITE/.test(apiBase()),
    version: app.getVersion(),
  };
}

// ── API ──
async function api(pathname, { method = "GET", body } = {}) {
  const res = await fetch(apiBase() + pathname, {
    method,
    headers: { "content-type": "application/json", ...(S.token ? { authorization: `Bearer ${dec(S.token)}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({ ok: false, error: `Server error (${res.status})` }));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

function absorb(d) {
  cache = { license: d.license ?? cache.license, servers: d.servers ?? cache.servers, dns: d.dns ?? cache.dns, ports: d.ports ?? cache.ports, brand: d.brand ?? cache.brand };
  if (!S.settings.serverId || !cache.servers.some((s) => s.id === S.settings.serverId))
    S.settings.serverId = (cache.servers.find((s) => s.online) || cache.servers[0])?.id || null;
}

async function refresh() {
  if (!S.token) return;
  try {
    absorb(await api(`/api/app/me?install=${S.installId}`));
    saveState();
    push();
    dnsAutoUpdate();
  } catch (e) {
    if (e.status === 401 || e.status === 403) await forceLogout(e.status === 403 ? e.message : "Your session expired. Log in again.");
  }
}

async function forceLogout(message) {
  wantConnected = false;
  await tunnel.down().catch(() => {});
  S.token = null; S.lastConfig = null;
  saveState();
  setStatus({ phase: "disconnected", message, ip: null, since: null, stats: null });
}

// ── WireGuard keypair (private key never leaves this PC) ──
function keypair() {
  if (!dec(S.privateKey)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519", {
      publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    S.publicKey = publicKey.subarray(-32).toString("base64");
    S.privateKey = enc(privateKey.subarray(-32).toString("base64"));
    saveState();
  }
  return { publicKey: S.publicKey, privateKey: dec(S.privateKey) };
}

async function checkIp() {
  try {
    const { ip } = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    setStatus({ ip });
  } catch { setStatus({ ip: null }); }
}

// ── Connect / disconnect ──
async function connect() {
  if (busy) return;
  busy = true; wantConnected = true;
  try {
    if (!tunnel.isInstalled()) {
      setStatus({ phase: "installing", message: "Installing the WireGuard driver (one time)…" });
      await tunnel.install((m) => setStatus({ message: m }));
    }
    setStatus({ phase: "connecting", message: "Requesting secure tunnel…" });
    const { publicKey, privateKey } = keypair();
    const { settings } = S;
    const d = await api("/api/app/connect", {
      method: "POST",
      body: {
        installId: S.installId, deviceName: os.hostname(), publicKey, serverId: settings.serverId,
        options: { port: settings.port, dns: settings.dns, split: settings.split, cidrs: settings.cidrs, killSwitch: settings.killSwitch && !S.share.enabled },
      },
    });
    const config = d.config.replace("__PRIVATE_KEY__", privateKey);
    S.lastConfig = enc(config); // lets the watchdog restore the tunnel even if the internet is down
    saveState();
    setStatus({ message: "Starting tunnel…" });
    await tunnel.up(config);
    setStatus({ phase: "connected", message: "", since: Date.now() });
    startWatchdog();
    if (S.share.enabled && share.phase !== "starting") applySharing(false);
    setTimeout(checkIp, 1500);
  } catch (e) {
    wantConnected = false;
    await tunnel.down().catch(() => {});
    setStatus({ phase: "disconnected", message: e.message, since: null });
    if (e.status === 401 || /^License /.test(e.message)) await forceLogout(e.message);
  } finally {
    busy = false;
  }
}

async function disconnect() {
  wantConnected = false;
  if (S.share.enabled) setShare({ phase: "paused", message: "VPN is off, so the console has no internet until you reconnect." });
  clearInterval(watchdogTimer);
  setStatus({ phase: "disconnecting", message: "" });
  await tunnel.down().catch(() => {});
  setStatus({ phase: "disconnected", since: null, stats: null });
  setTimeout(checkIp, 1000);
}

// Keeps the tunnel alive: if the service dies while the user wants to be connected,
// bring it straight back up from the cached config (kill switch gap stays tiny).
function startWatchdog() {
  clearInterval(watchdogTimer);
  watchdogTimer = setInterval(async () => {
    if (!wantConnected || busy) return;
    if (!(await tunnel.isUp())) {
      setStatus({ phase: "connecting", message: "Connection dropped — reconnecting…" });
      try {
        busy = true;
        await tunnel.up(dec(S.lastConfig));
        setStatus({ phase: "connected", message: "" });
        if (S.share.enabled) applySharing(false);
      } catch (e) {
        setStatus({ message: "Reconnect failed: " + e.message });
      } finally { busy = false; }
      return;
    }
    const stats = await tunnel.stats();
    const stale = stats?.handshakeAgeSec != null && stats.handshakeAgeSec > 180;
    setStatus({ stats, phase: "connected", message: stale ? "Waiting for server response…" : "" });
  }, 2000);
}

// Keep this PC's home IP registered for Smart DNS (only possible while the VPN is off)
async function dnsAutoUpdate() {
  if (!S.dnsAuto || !S.token || status.phase === "connected" || status.phase === "connecting") return;
  const ip = await homeIPv4();
  await api("/api/smartdns", { method: "POST", body: { action: "auto", installId: S.installId, ip } }).catch(() => {});
}

// ── Share VPN with console ──
function setShare(patch) { share = { ...share, ...patch }; push(); }

// fresh = first start (starts the hotspot); otherwise just re-point ICS at the new VPN adapter
async function applySharing(fresh = true) {
  setShare({ phase: "starting", message: fresh && S.share.mode === "hotspot" ? "Starting Wi-Fi hotspot…" : "Routing console through the VPN…" });
  try {
    const r = fresh ? await sharing.start(S.share) : await sharing.reapply(S.share).catch(() => sharing.start(S.share));
    setShare({ phase: "on", message: "", adapter: r.adapter });
    pollShare();
  } catch (e) {
    setShare({ phase: "error", message: e.message });
  }
}

function pollShare() {
  clearInterval(shareTimer);
  if (S.share.mode !== "hotspot") return;
  const tick = async () => {
    if (!S.share.enabled) return clearInterval(shareTimer);
    const st = await sharing.status().catch(() => null);
    if (st) setShare({ clients: st.clients });
  };
  tick();
  shareTimer = setInterval(tick, 15000);
}

async function enableSharing() {
  S.share.enabled = true; saveState();
  // Sharing needs the VPN up without the PC-only kill switch → (re)connect first.
  if (status.phase !== "connected" || S.settings.killSwitch) {
    setShare({ phase: "starting", message: "Connecting the VPN…" });
    await connect();
    if (status.phase !== "connected") { S.share.enabled = false; saveState(); return setShare({ phase: "error", message: status.message || "VPN didn't connect." }); }
  }
  await applySharing(true);
  if (share.phase === "error") { S.share.enabled = false; saveState(); push(); }
}

async function disableSharing() {
  S.share.enabled = false; saveState();
  clearInterval(shareTimer);
  setShare({ phase: "stopping", message: "" });
  await sharing.stop(S.share).catch(() => {});
  setShare({ phase: "off", clients: null });
  // Put the PC kill switch back if the user has it on
  if (status.phase === "connected" && S.settings.killSwitch) await connect();
}

// ── Launch at startup (elevated apps need a scheduled task, not the Run key) ──
function setStartup(on) {
  const task = "CrimsonShield VPN";
  const args = on
    ? ["/create", "/tn", task, "/tr", `"${process.execPath}" --hidden`, "/sc", "onlogon", "/rl", "highest", "/f"]
    : ["/delete", "/tn", task, "/f"];
  if (process.platform === "win32") execFile("schtasks.exe", args, { windowsHide: true }, () => {});
}

// ── Window + tray ──
const ICON = path.join(__dirname, "renderer", "icon.png");
const ICON_ON = path.join(__dirname, "renderer", "icon-on.png");

function createWindow(show = true) {
  win = new BrowserWindow({
    width: 400, height: 680, minWidth: 380, minHeight: 600, frame: false, resizable: true, show: false,
    backgroundColor: "#07030a", icon: ICON, title: "CrimsonShield VPN",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => show && win.show());
  win.on("close", (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

function updateTray() {
  if (!tray) return;
  const on = status.phase === "connected";
  tray.setImage(nativeImage.createFromPath(on ? ICON_ON : ICON).resize({ width: 16, height: 16 }));
  const srv = cache.servers.find((s) => s.id === S.settings.serverId);
  tray.setToolTip(`CrimsonShield VPN — ${on ? `Connected${srv ? " to " + srv.name : ""}` : "Disconnected"}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: on ? `Connected${srv ? " · " + srv.name : ""}` : "Not connected", enabled: false },
    { type: "separator" },
    on ? { label: "Disconnect", click: disconnect } : { label: "Connect", enabled: !!S.token && !busy, click: connect },
    { label: "Open CrimsonShield", click: () => { win.show(); win.focus(); } },
    { type: "separator" },
    { label: "Disconnect & quit", click: quit },
  ]));
}

async function quit() {
  app.isQuitting = true;
  if (S.share.enabled) await sharing.stop(S.share).catch(() => {});
  wantConnected = false;
  await tunnel.down().catch(() => {});
  app.quit();
}

// ── IPC from the UI ──
ipcMain.handle("state", () => publicState());
ipcMain.handle("setApiBase", (_e, url) => {
  const u = String(url || "").trim().replace(/\/$/, "");
  if (!/^https:\/\/[\w.-]+(:\d+)?$/.test(u) && !/^http:\/\/localhost(:\d+)?$/.test(u)) return { ok: false, error: "Enter a URL like https://your-site.netlify.app" };
  S.apiBase = u; saveState(); push();
  return { ok: true };
});
ipcMain.handle("login", async (_e, key) => {
  try {
    const d = await api("/api/app/login", { method: "POST", body: { key, installId: S.installId, deviceName: os.hostname() } });
    S.token = enc(d.token);
    absorb(d);
    saveState();
    setStatus({ message: "" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: /fetch|timeout|abort/i.test(e.message) ? `Can't reach ${apiBase()}` : e.message };
  }
});
ipcMain.handle("logout", async () => {
  await tunnel.down().catch(() => {});
  wantConnected = false;
  await api("/api/app/logout", { method: "POST", body: { installId: S.installId } }).catch(() => {});
  await forceLogout("");
  return { ok: true };
});
ipcMain.handle("connect", () => connect());
// Smart DNS (register this home network so consoles/TVs can use the DNS servers)
// Home IPv4 (api.ipify.org only answers over IPv4, which is what consoles use for DNS)
async function homeIPv4() {
  try { return (await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(6000) }).then((r) => r.json())).ip; } catch { return null; }
}
ipcMain.handle("dns", async (_e, body) => {
  try {
    const ip = await homeIPv4();
    const d = body ? await api("/api/smartdns", { method: "POST", body: { ...body, ip } }) : await api("/api/smartdns" + (ip ? `?ip=${ip}` : ""));
    return { ok: true, ...d, autoUpdate: !!S.dnsAuto };
  } catch (e) { return { ok: false, error: e.message, status: e.status, autoUpdate: !!S.dnsAuto }; }
});
ipcMain.handle("dnsAuto", async (_e, on) => { S.dnsAuto = !!on; saveState(); if (on) await dnsAutoUpdate(); return { ok: true }; });
ipcMain.handle("shareInfo", async () => {
  const i = await sharing.info().catch(() => ({ adapters: [], hotspotCapable: false }));
  setShare({ adapters: i.adapters || [], hotspotCapable: !!i.hotspotCapable });
  if (!S.share.adapter && i.adapters?.length) { S.share.adapter = (i.adapters.find((a) => a.status !== "Up") || i.adapters[0]).name; saveState(); push(); }
  return { ok: true };
});
ipcMain.handle("shareSet", async (_e, patch) => {
  const wasOn = S.share.enabled;
  if (wasOn) await disableSharing();
  for (const k of ["mode", "adapter", "ssid", "pass"]) if (patch[k] !== undefined) S.share[k] = String(patch[k]).slice(0, 32);
  if (S.share.pass.length < 8) S.share.pass = newShare().pass;
  saveState(); push();
  if (wasOn) await enableSharing();
  return { ok: true };
});
ipcMain.handle("shareToggle", async (_e, on) => { on ? await enableSharing() : await disableSharing(); return { ok: true }; });
ipcMain.handle("disconnect", () => disconnect());
ipcMain.handle("refresh", () => refresh());
ipcMain.handle("checkIp", () => checkIp());
ipcMain.handle("settings", async (_e, patch) => {
  const before = { ...S.settings };
  const allowed = Object.keys(DEFAULT_SETTINGS);
  for (const k of Object.keys(patch)) if (allowed.includes(k)) S.settings[k] = patch[k];
  saveState();
  if (patch.launchAtStartup !== undefined && patch.launchAtStartup !== before.launchAtStartup) setStartup(patch.launchAtStartup);
  push();
  // Tunnel-affecting change while connected → reconnect with the new settings
  const tunnelKeys = ["serverId", "port", "dns", "split", "cidrs", "killSwitch"];
  if (status.phase === "connected" && tunnelKeys.some((k) => patch[k] !== undefined && patch[k] !== before[k])) await connect();
  return { ok: true };
});
ipcMain.on("window", (_e, action) => {
  if (action === "min") win.minimize();
  if (action === "close") win.hide();
});
ipcMain.on("open", (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

// ── Boot ──
app.on("second-instance", () => { win?.show(); win?.focus(); });
app.whenReady().then(async () => {
  app.setAppUserModelId("net.crimsonshield.vpn");
  loadState();
  saveState();
  createWindow(!process.argv.includes("--hidden"));
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on("click", () => { win.show(); win.focus(); });

  // Tunnel left running from a previous session?
  if (await tunnel.isUp()) { wantConnected = true; setStatus({ phase: "connected", since: Date.now() }); startWatchdog(); }
  if (S.share.enabled) {
    if (status.phase === "connected") applySharing(false);
    else setShare({ phase: "paused", message: "Connect the VPN to give your console internet." });
  }
  updateTray();
  checkIp();
  await refresh();
  licenseTimer = setInterval(refresh, 10 * 60e3); // re-validates the license every 10 min
  if (S.token && S.settings.autoConnect && status.phase !== "connected") connect();
});
app.on("window-all-closed", (e) => e.preventDefault?.());
