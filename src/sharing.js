// "Share VPN with console": routes a PS5 / Xbox / Switch (or any device) through
// this PC's VPN tunnel, using Windows Internet Connection Sharing (ICS).
//   • hotspot mode  → starts Windows Mobile Hotspot, console joins that Wi-Fi
//   • ethernet mode → console plugged into this PC with a cable
// In both cases ICS is pointed at the VPN adapter, so the console's traffic is NATed
// into the tunnel. If the VPN drops, the console simply has no internet (no leaks).
const { execFile } = require("node:child_process");

const PS_COMMON = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskOp  = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + String.raw`1' })[0]
$asTaskAct = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function AwaitOp($op, [Type]$t) { $task = $asTaskOp.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
function AwaitAct($act) { $task = $asTaskAct.Invoke($null, @($act)); $task.Wait(-1) | Out-Null }
[void][Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]
[void][Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime]

function Get-TetherManager {
  # Host the hotspot on a real Wi-Fi/Ethernet profile (IANA 71 / 6), never the VPN adapter.
  $profiles = [Windows.Networking.Connectivity.NetworkInformation]::GetConnectionProfiles()
  foreach ($p in $profiles) {
    if (-not $p.NetworkAdapter) { continue }
    $iana = $p.NetworkAdapter.IanaInterfaceType
    if ($iana -ne 6 -and $iana -ne 71) { continue }
    if ($p.GetNetworkConnectivityLevel().ToString() -eq 'None') { continue }
    try {
      $tm = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($p)
      if ($tm) { return $tm }
    } catch {}
  }
  throw "This PC can't create a Wi-Fi hotspot (no compatible Wi-Fi adapter). Use Ethernet cable mode instead."
}

function Get-Ics {
  $m = New-Object -ComObject HNetCfg.HNetShare
  $list = @()
  foreach ($c in @($m.EnumEveryConnection)) {
    $list += [pscustomobject]@{ Name = $m.NetConnectionProps.Invoke($c).Name; Conf = $m.INetSharingConfigurationForINetConnection.Invoke($c) }
  }
  return $list
}

function Clear-Sharing([string[]]$names) {
  foreach ($x in Get-Ics) { if ($x.Conf.SharingEnabled -and ($names -contains $x.Name)) { $x.Conf.DisableSharing() } }
}

function Set-Sharing([string]$publicName, [string]$privateName) {
  Set-Service SharedAccess -StartupType Manual -ErrorAction SilentlyContinue
  Start-Service SharedAccess -ErrorAction SilentlyContinue
  $all = Get-Ics
  foreach ($x in $all) { if ($x.Conf.SharingEnabled) { $x.Conf.DisableSharing() } }   # only one ICS pair can exist
  $pub  = ($all | Where-Object { $_.Name -eq $publicName  } | Select-Object -First 1)
  $priv = ($all | Where-Object { $_.Name -eq $privateName } | Select-Object -First 1)
  if (-not $pub)  { throw "VPN adapter '$publicName' not found. Connect the VPN first." }
  if (-not $priv) { throw "Network adapter '$privateName' not found." }
  $pub.Conf.EnableSharing(0)    # 0 = public (internet side)  → the VPN tunnel
  $priv.Conf.EnableSharing(1)   # 1 = private (console side)
}

function Get-HotspotAdapter {
  $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq '192.168.137.1' } | Select-Object -First 1
  if ($ip) { return $ip.InterfaceAlias }
  $a = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -like '*Wi-Fi Direct Virtual*' -and $_.Status -eq 'Up' } | Select-Object -First 1
  if ($a) { return $a.Name }
  throw "Hotspot started but its network adapter wasn't found."
}
`;

const SCRIPTS = {
  // → { adapters: [{name, desc, status}], hotspotCapable }
  info: String.raw`
$adapters = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.MediaType -eq '802.3' } | ForEach-Object { @{ name = $_.Name; desc = $_.InterfaceDescription; status = "$($_.Status)" } })
$capable = $true; try { $null = Get-TetherManager } catch { $capable = $false }
@{ adapters = $adapters; hotspotCapable = $capable } | ConvertTo-Json -Compress -Depth 4`,

  startHotspot: String.raw`
$tm = Get-TetherManager
$cfg = $tm.GetCurrentAccessPointConfiguration()
$cfg.Ssid = $env:CSV_SSID
$cfg.Passphrase = $env:CSV_PASS
AwaitAct ($tm.ConfigureAccessPointAsync($cfg))
if ($tm.TetheringOperationalState.ToString() -ne 'On') {
  $r = AwaitOp ($tm.StartTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
  if ($r.Status.ToString() -ne 'Success') { throw "Hotspot failed to start ($($r.Status)). $($r.AdditionalErrorMessage)" }
}
Start-Sleep -Seconds 2
$priv = Get-HotspotAdapter
Set-Sharing $env:CSV_TUNNEL $priv
@{ ok = $true; adapter = $priv } | ConvertTo-Json -Compress`,

  startEthernet: String.raw`
Set-Sharing $env:CSV_TUNNEL $env:CSV_ADAPTER
@{ ok = $true; adapter = $env:CSV_ADAPTER } | ConvertTo-Json -Compress`,

  // Re-point ICS after the VPN adapter was recreated (reconnect / server change)
  reapply: String.raw`
$priv = if ($env:CSV_MODE -eq 'hotspot') { Get-HotspotAdapter } else { $env:CSV_ADAPTER }
Set-Sharing $env:CSV_TUNNEL $priv
@{ ok = $true; adapter = $priv } | ConvertTo-Json -Compress`,

  stop: String.raw`
$names = @($env:CSV_TUNNEL)
if ($env:CSV_ADAPTER) { $names += $env:CSV_ADAPTER }
try { $names += (Get-HotspotAdapter) } catch {}
Clear-Sharing $names
if ($env:CSV_MODE -eq 'hotspot') {
  try {
    $tm = Get-TetherManager
    if ($tm.TetheringOperationalState.ToString() -eq 'On') { $null = AwaitOp ($tm.StopTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult]) }
  } catch {}
}
@{ ok = $true } | ConvertTo-Json -Compress`,

  // → { clients, max, state }
  status: String.raw`
try {
  $tm = Get-TetherManager
  @{ clients = $tm.ClientCount; max = $tm.MaxClientCount; state = $tm.TetheringOperationalState.ToString() } | ConvertTo-Json -Compress
} catch { @{ clients = $null; state = 'Unknown' } | ConvertTo-Json -Compress }`,
};

function runPs(name, env = {}) {
  const script = PS_COMMON + SCRIPTS[name];
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 60000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        const line = String(stdout).trim().split(/\r?\n/).pop();
        if (err) {
          const msg = String(stderr).split(/\r?\n/).find((l) => l.trim() && !/^At line|^\+|CategoryInfo|FullyQualifiedErrorId/.test(l.trim()));
          return reject(new Error((msg || err.message).replace(/^.*?: /, "").trim()));
        }
        try { resolve(JSON.parse(line)); } catch { resolve({}); }
      }
    );
  });
}

function createSharing(tunnelName) {
  const base = { CSV_TUNNEL: tunnelName };
  const envFor = (s) => ({ ...base, CSV_MODE: s.mode, CSV_SSID: s.ssid, CSV_PASS: s.pass, CSV_ADAPTER: s.adapter || "" });
  return {
    info: () => runPs("info", base),
    start: (s) => runPs(s.mode === "hotspot" ? "startHotspot" : "startEthernet", envFor(s)),
    reapply: (s) => runPs("reapply", envFor(s)),
    stop: (s) => runPs("stop", envFor(s)),
    status: () => runPs("status", base),
  };
}

// Simulated version for UI development on macOS/Linux
function createFakeSharing() {
  let on = false;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    info: async () => ({ adapters: [{ name: "Ethernet 2", desc: "Realtek PCIe GbE", status: "Disconnected" }], hotspotCapable: true }),
    start: async (s) => { await wait(700); on = true; return { ok: true, adapter: s.mode === "hotspot" ? "Local Area Connection* 12" : s.adapter }; },
    reapply: async () => ({ ok: true }),
    stop: async () => { await wait(300); on = false; return { ok: true }; },
    status: async () => ({ clients: on ? 1 : 0, max: 8, state: on ? "On" : "Off" }),
  };
}

module.exports = {
  createSharing: process.platform === "win32" && !process.env.CSV_FAKE_TUNNEL ? createSharing : createFakeSharing,
};
