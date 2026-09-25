const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let S = null;

// Windows can't draw flag emojis, so turn "🇺🇸" into a bundled flag image (flags/us.svg).
const flagCode = (f) => {
  const cps = [...String(f || "")].map((c) => c.codePointAt(0)).filter((c) => c >= 0x1f1e6 && c <= 0x1f1ff);
  return cps.length === 2 ? cps.map((c) => String.fromCharCode(c - 0x1f1e6 + 97)).join("") : "";
};
const flagImg = (f) => {
  const cc = flagCode(f);
  return cc ? `<img class="flag-img" src="flags/${cc}.svg" alt="${cc.toUpperCase()}">` : `<span class="flag-globe">🌐</span>`;
};

const fmtBytes = (n) => {
  if (n == null || isNaN(n)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Lifetime");
const pad = (n) => String(n).padStart(2, "0");

function render(state) {
  S = state;
  $("login").classList.toggle("hidden", state.loggedIn);
  $("main").classList.toggle("hidden", !state.loggedIn);
  if (!state.loggedIn) {
    $("apiHost").textContent = state.apiConfigured ? state.apiBase.replace(/^https?:\/\//, "") : "not set";
    if (!state.apiConfigured) $("apiForm").classList.remove("hidden");
    if (state.status.message) { $("loginErr").textContent = state.status.message; $("loginErr").classList.remove("hidden"); }
    return;
  }

  const { phase, message, ip, stats } = state.status;
  const busy = ["connecting", "disconnecting", "installing"].includes(phase);
  document.body.classList.toggle("connected", phase === "connected");
  document.body.classList.toggle("busy", busy);

  const srv = state.servers.find((s) => s.id === state.settings.serverId);
  $("stLabel").textContent = { connected: "Protected", connecting: "Connecting", disconnecting: "Disconnecting", installing: "Setting up" }[phase] || "Not protected";
  $("stSub").textContent = phase === "connected" ? `Encrypted via ${srv ? srv.name : "VPN"} · WireGuard` : busy ? "Please wait…" : "Your real IP is visible";
  $("power").setAttribute("aria-label", phase === "connected" ? "Disconnect" : "Connect");
  $("msg").textContent = message || "";

  $("locFlag").innerHTML = flagImg(srv?.flag);
  $("locName").textContent = srv ? srv.name : "Choose a server";
  $("locCountry").textContent = srv ? `${srv.country}${srv.online ? "" : " · offline"}` : "";

  $("ipVal").textContent = ip || "—";
  $("rxVal").textContent = phase === "connected" ? fmtBytes(stats?.rx) : "—";
  $("txVal").textContent = phase === "connected" ? fmtBytes(stats?.tx) : "—";

  renderServers();
  renderShare(state);

  // Settings
  document.querySelectorAll("[data-s]").forEach((el) => {
    const v = state.settings[el.dataset.s];
    if (el.type === "checkbox") el.checked = !!v;
    else if (document.activeElement !== el) el.value = v ?? "";
  });
  $("portSel").innerHTML = state.ports.map((p) => `<option value="${p.port}">${esc(p.label)}</option>`).join("");
  $("portSel").value = state.settings.port;
  $("dnsSel").innerHTML = Object.entries(state.dns).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("");
  $("dnsSel").value = state.settings.dns;
  const split = state.settings.split;
  $("cidrs").classList.toggle("hidden", !(split === "exclude" || split === "include"));
  const ks = document.querySelector('[data-s="killSwitch"]');
  ks.disabled = split !== "full";
  $("ksNote").textContent = state.share?.enabled ? "Paused while sharing with a console" : split !== "full" ? "Only available with split tunneling off" : "Blocks all internet if the VPN drops";

  const L = state.license || {};
  $("accPlan").textContent = L.plan || "—";
  $("accExp").textContent = L.plan ? fmtDate(L.expiresAt) : "—";
  $("accDev").textContent = L.plan ? `${L.deviceCount} / ${L.maxDevices}` : "—";
  $("accKey").textContent = L.hint ? "••••-" + L.hint : "—";
  $("verLine").textContent = `v${state.version} · ${state.deviceName}`;
}

function renderServers() {
  const q = $("srvSearch").value.toLowerCase();
  $("srvList").innerHTML = S.servers
    .filter((s) => !q || `${s.name} ${s.country}`.toLowerCase().includes(q))
    .map((s) => `<div class="srv ${s.id === S.settings.serverId ? "sel" : ""} ${s.online ? "" : "off"}" data-id="${esc(s.id)}">
        <span class="flag">${flagImg(s.flag)}</span>
        <div class="meta"><b>${esc(s.name)}</b><small>${esc(s.country)}${s.online ? (s.load != null ? ` · load ${Math.round(s.load * 100)}%` : "") : " · offline"}</small></div>
        <span class="dot"></span></div>`).join("") || '<p class="muted">No servers found.</p>';
}

// Connection timer
setInterval(() => {
  if (!S) return;
  const since = S.status.phase === "connected" && S.status.since;
  const t = since ? Math.floor((Date.now() - since) / 1000) : 0;
  $("timer").textContent = `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}, 1000);

// ── Events ──
$("tbMin").onclick = () => vpn.window("min");
$("tbClose").onclick = () => vpn.window("close");
$("buyLink").onclick = (e) => { e.preventDefault(); if (S?.brand?.purchaseUrl) vpn.open(S.brand.purchaseUrl); else vpn.open(S.apiBase); };

$("apiEdit").onclick = (e) => { e.preventDefault(); $("apiInput").value = S.apiConfigured ? S.apiBase : ""; $("apiForm").classList.toggle("hidden"); };
$("apiForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await vpn.setApiBase($("apiInput").value);
  if (!r.ok) { $("loginErr").textContent = r.error; $("loginErr").classList.remove("hidden"); return; }
  $("loginErr").classList.add("hidden"); $("apiForm").classList.add("hidden");
});

$("key").addEventListener("input", (e) => {
  const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  e.target.value = raw.length > 3 ? raw.slice(0, 3) + "-" + raw.slice(3).match(/.{1,4}/g).join("-") : raw;
});
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("loginBtn");
  btn.disabled = true; btn.textContent = "Checking key…"; $("loginErr").classList.add("hidden");
  const r = await vpn.login($("key").value);
  btn.disabled = false; btn.textContent = "Activate";
  if (!r.ok) { $("loginErr").textContent = r.error; $("loginErr").classList.remove("hidden"); return; }
  $("key").value = "";
  render(await vpn.state());
});

$("power").onclick = () => {
  const p = S.status.phase;
  if (p === "connected") vpn.disconnect();
  else if (p === "disconnected") vpn.connect();
};
$("locBtn").onclick = () => showPage("servers");
$("srvSearch").oninput = renderServers;
$("srvList").onclick = (e) => {
  const el = e.target.closest(".srv");
  if (!el || el.classList.contains("off")) return;
  vpn.settings({ serverId: el.dataset.id });
  showPage("home");
};

document.querySelectorAll("[data-s]").forEach((el) => {
  el.addEventListener("change", () => {
    const k = el.dataset.s;
    let v = el.type === "checkbox" ? el.checked : el.value;
    if (k === "port") v = Number(v);
    vpn.settings({ [k]: v });
  });
});
$("logoutBtn").onclick = async () => {
  const b = $("logoutBtn");
  if (b.textContent !== "Click again to confirm") { b.textContent = "Click again to confirm"; setTimeout(() => (b.textContent = "Log out of this PC"), 3000); return; }
  b.disabled = true;
  await vpn.logout();
  b.disabled = false; b.textContent = "Log out of this PC";
  showPage("home");
};

function showPage(p) {
  document.querySelectorAll(".page").forEach((el) => el.classList.toggle("hidden", el.id !== "p-" + p));
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.p === p));
  if (p === "servers") vpn.refresh();
}
document.querySelector(".tabs").onclick = (e) => { const b = e.target.closest("button"); if (b) showPage(b.dataset.p); };

vpn.onState(render);
vpn.state().then(render);


// ── Console sharing ──
const CONSOLE_GUIDES = {
  hotspot: {
    ps: ["Settings → Network → Settings → Set Up Internet Connection.", "Pick the Wi-Fi called <b>{ssid}</b> and enter the password <b>{pass}</b>.", "Run <b>Test Internet Connection</b>. It should pass."],
    xbox: ["Settings → General → Network settings → Set up wireless network.", "Pick <b>{ssid}</b> and enter the password <b>{pass}</b>.", "Choose <b>Test network connection</b>."],
    switch: ["System Settings → Internet → Internet Settings.", "Pick <b>{ssid}</b> and enter the password <b>{pass}</b>.", "The Switch tests the connection automatically."],
  },
  ethernet: {
    ps: ["Plug an Ethernet cable from this PC into the PlayStation.", "Settings → Network → Settings → Set Up Internet Connection → <b>Set Up Wired LAN</b> (automatic).", "Run <b>Test Internet Connection</b>."],
    xbox: ["Plug an Ethernet cable from this PC into the Xbox.", "The Xbox picks the cable automatically. Go to Settings → General → Network settings → <b>Test network connection</b>."],
    switch: ["The Switch needs a USB-to-Ethernet adapter (or the Switch OLED dock's LAN port) cabled to this PC.", "System Settings → Internet → <b>Wired Connection</b> → Connect to Internet."],
  },
};
let guideKey = "ps", shareInfoLoaded = false;

function renderShare(state) {
  const sh = state.share;
  if (!sh) return;
  if (!shareInfoLoaded) { shareInfoLoaded = true; vpn.shareInfo(); }
  const on = sh.enabled;
  const vpnOn = state.status.phase === "connected";
  $("shToggle").checked = on;
  $("shToggle").disabled = ["starting", "stopping"].includes(sh.phase);
  $("shToggle").closest(".toggle").classList.toggle("on", on && sh.phase === "on");
  $("shTitle").textContent = !on ? "Sharing is off" : ({ starting: "Starting…", on: "Console protected", paused: "Paused (VPN is off)", error: "Couldn't start sharing", stopping: "Stopping…" }[sh.phase] || "Sharing on");
  $("shSub").textContent = !on
    ? "Turn on to give your console a protected connection"
    : sh.phase === "on"
      ? (sh.mode === "hotspot" ? `Console joins Wi-Fi "${sh.ssid}"` : `Console plugged into "${sh.adapter}"`)
      : "";
  $("shMsg").textContent = sh.message || (on && vpnOn ? "PC kill switch is paused while sharing. If the VPN drops, the console just loses internet (nothing leaks)." : "");

  document.querySelectorAll("#shMode button").forEach((b) => {
    b.classList.toggle("on", b.dataset.m === sh.mode);
    b.disabled = on && sh.phase === "starting";
  });
  const noWifi = sh.hotspotCapable === false;
  $("shNoWifi").classList.toggle("hidden", !(noWifi && sh.mode === "hotspot"));
  $("shNoWifi").textContent = "This PC doesn't have a Wi-Fi adapter that can host a hotspot. Use Ethernet cable mode, or add a cheap USB Wi-Fi adapter.";
  $("shHotspot").classList.toggle("hidden", sh.mode !== "hotspot");
  $("shEthernet").classList.toggle("hidden", sh.mode !== "ethernet");
  if (document.activeElement !== $("shSsid")) $("shSsid").value = sh.ssid;
  if (document.activeElement !== $("shPass")) $("shPass").value = sh.pass;
  $("shClients").textContent = on && sh.phase === "on" && sh.clients != null ? `${sh.clients}${sh.clients === 1 ? " device" : " devices"}` : "—";
  const opts = (sh.adapters || []).map((a) => `<option value="${esc(a.name)}">${esc(a.name)} — ${esc(a.desc)}${a.status === "Up" ? "" : " (not plugged in)"}</option>`).join("");
  if ($("shAdapter").dataset.sig !== opts) { $("shAdapter").innerHTML = opts || '<option value="">No Ethernet ports found</option>'; $("shAdapter").dataset.sig = opts; }
  $("shAdapter").value = sh.adapter || "";

  const steps = CONSOLE_GUIDES[sh.mode][guideKey].map((t) => `<li>${t.replace("{ssid}", esc(sh.ssid)).replace("{pass}", esc(sh.pass))}</li>`).join("");
  $("shGuide").innerHTML = steps;
}

$("shToggle").addEventListener("change", (e) => vpn.shareToggle(e.target.checked));
$("shMode").onclick = (e) => { const b = e.target.closest("button"); if (b && !b.disabled) vpn.shareSet({ mode: b.dataset.m }); };
$("shAdapter").onchange = (e) => vpn.shareSet({ adapter: e.target.value });
$("shSsid").onchange = (e) => vpn.shareSet({ ssid: e.target.value.trim() || "CrimsonShield" });
$("shPass").onchange = (e) => vpn.shareSet({ pass: e.target.value });
$("shGuideTabs").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  guideKey = b.dataset.g;
  document.querySelectorAll("#shGuideTabs button").forEach((x) => x.classList.toggle("on", x === b));
  renderShare(S);
};


// ── Smart DNS ──
let dnsLoaded = false;
function renderDns(d) {
  $("dnsAuto").checked = !!d.autoUpdate;
  if (!d.ok) {
    if (d.status === 404) { $("dnsYou").textContent = "Smart DNS isn't enabled for this service."; $("dnsAdd").disabled = true; return; }
    $("dnsErr").textContent = d.error; $("dnsErr").classList.remove("hidden");
    return;
  }
  $("dnsErr").classList.add("hidden");
  const reg = d.registered.some((r) => r.current);
  $("dnsYou").innerHTML = d.onVpn
    ? `<span class="warn-text">VPN is on.</span> Disconnect to register your home network.`
    : `This network: <b>${esc(d.yourIp)}</b> · ${reg ? '<span class="ok-text">registered ✓</span>' : "not registered"} <span class="muted">(${d.registered.length}/${d.max} used)</span>`;
  $("dnsAdd").disabled = d.onVpn || reg;
  $("dnsAdd").textContent = reg ? "This network is registered" : "Register this network";
  $("dnsServers").innerHTML = d.servers.map((s) => `<div class="dns-row"><span class="flag">${flagImg(s.flag)}</span><div class="meta"><b>${esc(s.name)}</b><small>${s.ready ? `DNS <b class="ip">${esc(s.dns)}</b>` : "Smart DNS coming soon"}</small></div>${s.ready ? `<button class="btn sm" data-copy="${esc(s.dns)}">Copy</button>` : ""}</div>`).join("");
}
async function loadDns(body) { renderDns(await vpn.dns(body)); }
$("dnsAdd").onclick = () => loadDns({ action: "add", label: "Home" });
$("dnsAuto").onchange = async (e) => { await vpn.dnsAuto(e.target.checked); loadDns(); };
$("dnsServers").onclick = (e) => {
  const ip = e.target.dataset.copy; if (!ip) return;
  navigator.clipboard.writeText(ip); e.target.textContent = "Copied!"; setTimeout(() => (e.target.textContent = "Copy"), 1500);
};
document.querySelector('.tabs button[data-p="console"]').addEventListener("click", () => loadDns());
