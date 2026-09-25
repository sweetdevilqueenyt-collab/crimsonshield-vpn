// Controls the WireGuard for Windows tunnel service.
// The app never touches packets itself: WireGuard's audited, signed driver does the
// encryption; we install/remove a tunnel service with our config.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PF = process.env.ProgramW6432 || process.env.ProgramFiles || "C:\\Program Files";
const WG_DIR = path.join(PF, "WireGuard");
const WIREGUARD = path.join(WG_DIR, "wireguard.exe");
const WG = path.join(WG_DIR, "wg.exe");
const DATA_DIR = path.join(process.env.ProgramData || "C:\\ProgramData", "CrimsonShield");
const DOWNLOAD_INDEX = "https://download.wireguard.com/windows-client/";

const run = (file, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true, timeout: 120000, ...opts }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stdout, stderr })) : resolve(String(stdout))
    )
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createTunnel(name) {
  const service = `WireGuardTunnel$${name}`;

  const isInstalled = () => fs.existsSync(WIREGUARD) && fs.existsSync(WG);

  /** Download the latest signed WireGuard MSI from wireguard.com and install it silently. */
  async function install(onProgress = () => {}) {
    if (isInstalled()) return;
    const arch = { x64: "amd64", arm64: "arm64", ia32: "x86" }[process.arch] || "amd64";
    onProgress("Finding the latest WireGuard driver…");
    const index = await fetch(DOWNLOAD_INDEX).then((r) => r.text());
    const versions = [...index.matchAll(new RegExp(`wireguard-${arch}-([\\d.]+)\\.msi`, "g"))].map((m) => m[1]);
    if (!versions.length) throw new Error("Couldn't find the WireGuard installer. Install it manually from wireguard.com.");
    const latest = versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    const url = `${DOWNLOAD_INDEX}wireguard-${arch}-${latest}.msi`;

    onProgress(`Downloading WireGuard ${latest}…`);
    const msi = path.join(os.tmpdir(), `wireguard-${arch}-${latest}.msi`);
    fs.writeFileSync(msi, Buffer.from(await fetch(url).then((r) => r.arrayBuffer())));

    onProgress("Verifying signature…");
    const sig = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `$s = Get-AuthenticodeSignature -LiteralPath '${msi.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`,
    ]);
    const [status, subject] = sig.trim().split("|");
    if (status !== "Valid" || !/WireGuard LLC/i.test(subject)) {
      fs.rmSync(msi, { force: true });
      throw new Error("WireGuard installer failed signature check — aborted.");
    }

    onProgress("Installing WireGuard driver…");
    await run("msiexec.exe", ["/i", msi, "DO_NOT_LAUNCH=1", "/qn", "/norestart"], { timeout: 300000 });
    fs.rmSync(msi, { force: true });
    if (!isInstalled()) throw new Error("WireGuard install didn't complete.");
  }

  async function serviceState() {
    try {
      const out = await run("sc.exe", ["query", service]);
      const m = out.match(/STATE\s+:\s+\d+\s+(\w+)/);
      return m ? m[1] : "UNKNOWN"; // RUNNING, START_PENDING, STOPPED…
    } catch {
      return "NONE";
    }
  }

  async function down() {
    if ((await serviceState()) === "NONE") return;
    await run(WIREGUARD, ["/uninstalltunnelservice", name]).catch(() => {});
    for (let i = 0; i < 40 && (await serviceState()) !== "NONE"; i++) await sleep(250);
  }

  /** Start the tunnel. The config (incl. private key) only exists on disk for a moment. */
  async function up(configText) {
    await down();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, `${name}.conf`);
    fs.writeFileSync(file, configText, { mode: 0o600 });
    try {
      await run(WIREGUARD, ["/installtunnelservice", file]);
      for (let i = 0; i < 60; i++) {
        const st = await serviceState();
        if (st === "RUNNING") return;
        if (st === "STOPPED" || st === "NONE") break;
        await sleep(250);
      }
      throw new Error("The VPN tunnel failed to start.");
    } finally {
      await sleep(500);
      fs.rmSync(file, { force: true });
    }
  }

  async function isUp() {
    return (await serviceState()) === "RUNNING";
  }

  /** { rx, tx, handshakeAgeSec, endpoint } */
  async function stats() {
    try {
      const out = await run(WG, ["show", name, "dump"]);
      const peer = out.trim().split("\n")[1]?.split("\t");
      if (!peer) return null;
      const hs = Number(peer[4]);
      return { endpoint: peer[2], handshakeAgeSec: hs ? Math.floor(Date.now() / 1000 - hs) : null, rx: Number(peer[5]), tx: Number(peer[6]) };
    } catch {
      return null;
    }
  }

  return { isInstalled, install, up, down, isUp, stats };
}

// Simulated tunnel for developing the UI on macOS/Linux (never used on Windows unless CSV_FAKE_TUNNEL=1).
function createFakeTunnel() {
  let upAt = null, cfg = null;
  return {
    isInstalled: () => true,
    install: async () => {},
    up: async (c) => { await sleep(800); cfg = c; upAt = Date.now(); },
    down: async () => { await sleep(300); upAt = null; },
    isUp: async () => upAt != null,
    stats: async () => upAt && { endpoint: cfg.match(/Endpoint = (.*)/)?.[1], handshakeAgeSec: 5, rx: (Date.now() - upAt) * 900, tx: (Date.now() - upAt) * 120 },
  };
}

module.exports = {
  createTunnel: process.platform === "win32" && !process.env.CSV_FAKE_TUNNEL ? createTunnel : createFakeTunnel,
};
