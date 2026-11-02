const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');

const ROOT = path.join(app.getPath('appData'), '.dusk');
const MODS = ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'modernfix', 'entityculling', 'immediatelyfast'];
// Aikar-style G1GC flags: fewer lag spikes, steadier frame times
const JVM = ['-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC', '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40', '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20', '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4', '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90', '-XX:G1RSetUpdatingPauseTimePercent=5', '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1'];

let win, authMgr, mcAuth;
const send = (c, v) => win && !win.isDestroyed() && win.webContents.send(c, v);
const getJSON = async u => {
  const r = await fetch(u, { headers: { 'User-Agent': 'dusk-client/0.1' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
  return r.json();
};
async function download(url, dest) {
  const r = await fetch(url, { headers: { 'User-Agent': 'dusk-client/0.1' } });
  if (!r.ok) throw new Error(`Download failed (${r.status}): ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

async function ensureJava() {
  const dir = path.join(ROOT, 'java21');
  const find = () => {
    if (!fs.existsSync(dir)) return null;
    for (const d of fs.readdirSync(dir)) {
      const p = path.join(dir, d, 'bin', 'javaw.exe');
      if (fs.existsSync(p)) return p;
    }
    return null;
  };
  let j = find();
  if (j) return j;
  send('status', 'Downloading Java 21 (first launch only)...');
  const zip = path.join(ROOT, 'java21.zip');
  await download('https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse', zip);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${dir}'`], { windowsHide: true });
  fs.unlinkSync(zip);
  j = find();
  if (!j) throw new Error('Java install failed');
  return j;
}

async function ensureFabric(mc) {
  const loaders = await getJSON(`https://meta.fabricmc.net/v2/versions/loader/${mc}`);
  const lv = (loaders.find(l => l.loader.stable) || loaders[0]).loader.version;
  const id = `fabric-loader-${lv}-${mc}`;
  const f = path.join(ROOT, 'versions', id, `${id}.json`);
  if (!fs.existsSync(f)) {
    send('status', 'Installing Fabric loader...');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(await getJSON(`https://meta.fabricmc.net/v2/versions/loader/${mc}/${lv}/profile/json`)));
  }
  return id;
}

async function ensureMods(mc, inst) {
  const dir = path.join(inst, 'mods');
  const mark = path.join(dir, '.dusk-ok');
  if (fs.existsSync(mark)) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const slug of MODS) {
    send('status', `Installing performance mod: ${slug}`);
    const q = `loaders=${encodeURIComponent('["fabric"]')}&game_versions=${encodeURIComponent(`["${mc}"]`)}`;
    const vers = await getJSON(`https://api.modrinth.com/v2/project/${slug}/version?${q}`);
    const v = vers.find(x => x.version_type === 'release') || vers[0];
    if (!v) { send('status', `No ${slug} build for ${mc}, skipping`); continue; }
    const file = v.files.find(x => x.primary) || v.files[0];
    await download(file.url, path.join(dir, file.filename));
  }
  fs.writeFileSync(mark, '1');
}

ipcMain.handle('restore', async () => {
  try {
    const f = path.join(ROOT, 'auth.json');
    if (!fs.existsSync(f)) return null;
    authMgr = new Auth('select_account');
    const x = await authMgr.refresh(JSON.parse(fs.readFileSync(f, 'utf8')).t);
    mcAuth = await x.getMinecraft();
    return mcAuth.mclc().name;
  } catch { return null; }
});

ipcMain.handle('login', async () => {
  authMgr = new Auth('select_account');
  const x = await authMgr.launch('electron');
  mcAuth = await x.getMinecraft();
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'auth.json'), JSON.stringify({ t: x.save() }));
  return mcAuth.mclc().name;
});

ipcMain.handle('play', async (_, { version, ram }) => {
  if (!mcAuth) throw new Error('Sign in with your Microsoft account first');
  const java = await ensureJava();
  const id = await ensureFabric(version);
  const inst = path.join(ROOT, 'instances', version);
  await ensureMods(version, inst);
  const launcher = new Client();
  launcher.on('progress', e => e.total && send('progress', Math.round((e.task / e.total) * 100)));
  launcher.on('package-extract', () => send('status', 'Preparing game files...'));
  launcher.on('close', () => { send('closed'); });
  send('status', 'Downloading game files...');
  const proc = await launcher.launch({
    authorization: mcAuth.mclc(),
    root: ROOT,
    javaPath: java,
    version: { number: version, type: 'release', custom: id },
    memory: { max: `${ram}G`, min: `${Math.min(2, ram)}G` },
    customArgs: JVM,
    overrides: { gameDirectory: inst },
  });
  if (!proc) throw new Error('Minecraft failed to start');
  send('progress', 100);
  send('status', 'Minecraft is running');
});

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1120, height: 690, minWidth: 900, minHeight: 600,
    backgroundColor: '#120b24', autoHideMenuBar: true, title: 'Dusk',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile('index.html');
});
app.on('window-all-closed', () => app.quit());
