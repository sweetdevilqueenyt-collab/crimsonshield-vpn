const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vpn", {
  state: () => ipcRenderer.invoke("state"),
  setApiBase: (url) => ipcRenderer.invoke("setApiBase", url),
  login: (key) => ipcRenderer.invoke("login", key),
  logout: () => ipcRenderer.invoke("logout"),
  connect: () => ipcRenderer.invoke("connect"),
  disconnect: () => ipcRenderer.invoke("disconnect"),
  refresh: () => ipcRenderer.invoke("refresh"),
  checkIp: () => ipcRenderer.invoke("checkIp"),
  settings: (patch) => ipcRenderer.invoke("settings", patch),
  shareInfo: () => ipcRenderer.invoke("shareInfo"),
  dns: (body) => ipcRenderer.invoke("dns", body),
  dnsAuto: (on) => ipcRenderer.invoke("dnsAuto", on),
  shareSet: (patch) => ipcRenderer.invoke("shareSet", patch),
  shareToggle: (on) => ipcRenderer.invoke("shareToggle", on),
  window: (action) => ipcRenderer.send("window", action),
  open: (url) => ipcRenderer.send("open", url),
  onState: (cb) => ipcRenderer.on("state", (_e, s) => cb(s)),
});
