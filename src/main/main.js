'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, Menu, Tray, nativeImage, Notification, shell } = require('electron');

const pkg = require('../../package.json');
const O = require('./lib/origins');
const W = require('./lib/webapps');
const PROT = require('./lib/protect');

if (process.env.MAYFAIR_DESKTOP_DATA) app.setPath('userData', process.env.MAYFAIR_DESKTOP_DATA);
app.setName('Mayfair Desktop');

// no telemetry: Chromium's own reporting and background networking off
app.commandLine.appendSwitch('disable-background-networking');
{
  // Chromium feature switches must be set before the app is ready, so read the saved settings now.
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'mayfair-desktop', 'settings.json'), 'utf8')); } catch { /* first run */ }
  const f = require('./lib/privacy').featureSwitches({ secureDns: !!saved.secureDns, ech: saved.ech !== false });
  app.commandLine.appendSwitch('enable-features', f.enable);
  app.commandLine.appendSwitch('disable-features', f.disable);
}
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('disable-component-update');   // Chromium component updater (talks to Google hosts)
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-client-side-phishing-detection');
app.commandLine.appendSwitch('no-default-browser-check');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else boot();

function boot() {
  const { BrowserService } = require('./browser-service');
  const updater = require('./updater');
  let br = null;
  let tray = null;
  let pinnedItems = [];
  const queue = { files: [], links: [], apps: [] };
  const hiddenStart = process.argv.includes('--hidden');

  const take = (argv) => {
    const link = O.findDeepLink(argv);
    if (link) queue.links.push(link);
    const ap = W.findAppArg(argv);
    if (ap) queue.apps.push(ap);
    for (const f of O.findFileArgs(argv.slice(app.isPackaged ? 1 : 2))) queue.files.push(path.resolve(f));
  };
  const drain = () => {
    if (!br) return;
    for (const l of queue.links.splice(0)) br.openDeepLink(l);
    for (const a of queue.apps.splice(0)) br.openApp(a);
    for (const f of queue.files.splice(0)) br.handFile(f);
  };

  take(process.argv);
  app.on('second-instance', (_e, argv) => { take(argv); if (br) { br.showWindow(); drain(); } });
  app.on('open-file', (e, p) => { e.preventDefault(); queue.files.push(p); drain(); });          // macOS
  app.on('open-url', (e, u) => { e.preventDefault(); queue.links.push(u); drain(); });           // macOS

  function applyLoginItem(on) {
    try {
      if (process.platform === 'linux') {
        const dir = path.join(os.homedir(), '.config', 'autostart');
        const file = path.join(dir, 'mayfair-desktop.desktop');
        if (on) {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Mayfair Desktop\nExec="${process.env.APPIMAGE || process.execPath}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
        } else fs.rmSync(file, { force: true });
      } else app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
    } catch { /* not permitted: the setting simply has no effect */ }
  }

  function buildTray(on) {
    if (!on) { if (tray) { tray.destroy(); tray = null; } return; }
    if (tray) return;
    let img = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'tray.png'));
    if (process.platform === 'darwin') img.setTemplateImage(true);
    tray = new Tray(img);
    tray.setToolTip('Mayfair Desktop');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Mayfair', click: () => br.goHome() },
      { label: 'New tab', click: () => br.menuAction('newTab') },
      { label: 'Web apps', click: () => br.menuAction('apps') },
      { label: 'Private tab with Tor', click: () => br.menuAction('torTab') },
      ...(pinnedItems.length ? [{ type: 'separator' }, ...pinnedItems] : []),
      { type: 'separator' },
      { label: 'Full screen', type: 'checkbox', checked: br.win && br.win.isFullScreen(), click: () => br.toggleFullscreen() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
    tray.on('click', () => br.showWindow());
  }

  // Pinned web apps: tray menu, macOS Dock menu, Windows jump list. (No API can pin to the
  // Windows taskbar from code; the shortcut button in Web apps makes a launcher the user can pin.)
  function refreshPinned() {
    const pins = br.appsView().filter((a) => a.pinned);
    const items = pins.map((a) => ({ label: a.name + (a.badge ? ` (${a.badge})` : ''), click: () => br.openApp(a.id) }));
    if (process.platform === 'darwin' && app.dock) app.dock.setMenu(Menu.buildFromTemplate([{ label: 'Open Mayfair', click: () => br.goHome() }, ...(items.length ? [{ type: 'separator' }] : []), ...items]));
    if (process.platform === 'win32') {
      try { app.setJumpList(items.length ? [{ type: 'custom', name: 'Web apps', items: pins.map((a) => ({ type: 'task', title: a.name, program: process.execPath, args: '--app=' + a.id, description: 'Open ' + a.name })) }] : []); } catch { /* ignore */ }
    }
    pinnedItems = items;
    if (tray) buildTray(false), buildTray(true);
  }

  function buildMenu() {
    const mac = process.platform === 'darwin';
    const A = (id) => () => br.menuAction(id);
    // These keys are shown in the menu but not registered with the system (registerAccelerator: false): Mayfair's own apps keep
    // Ctrl+F, Ctrl+Y, Ctrl+D, Ctrl+W... Browser tabs report them themselves (lib/shortcuts.js) and the Browser window in Mayfair Cloud handles them.
    const tpl = [
      ...(mac ? [{ role: 'appMenu' }] : []),
      { label: 'File', submenu: [
        { label: 'New window', accelerator: 'CmdOrCtrl+N', click: A('newWindow') },
        { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: A('newTab') },
        { label: 'New private tab', accelerator: 'CmdOrCtrl+Shift+N', click: A('newPrivate') },
        { label: 'New Tor tab', accelerator: 'CmdOrCtrl+Alt+T', click: A('torTab') },
        { label: 'Close tab', accelerator: 'CmdOrCtrl+W', click: A('closeTab') },
        { type: 'separator' },
        { label: 'Mayfair home', accelerator: 'CmdOrCtrl+Shift+H', click: A('home') },
        { label: 'Web apps', accelerator: 'CmdOrCtrl+Shift+A', click: A('apps') },
        { label: 'Privacy', accelerator: 'CmdOrCtrl+Shift+P', click: A('privacy') },
        { label: 'About and licences', click: A('about') },
        { type: 'separator' },
        mac ? { role: 'close' } : { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }, { label: 'Find in page', accelerator: 'CmdOrCtrl+F', click: A('find') }] },
      { label: 'View', submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: A('reload') },
        { label: 'Address bar', accelerator: 'CmdOrCtrl+L', click: A('address') },
        { type: 'separator' },
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: A('zoomIn') },
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+Plus', visible: false, click: A('zoomIn') },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: A('zoomOut') },
        { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: A('zoomReset') },
        { type: 'separator' },
        { label: 'Full screen', accelerator: mac ? 'Ctrl+Cmd+F' : 'F11', click: A('fullscreen') },
        ...(PROT.devToolsAllowed({ isPackaged: app.isPackaged }) ? [{ role: 'toggleDevTools' }] : []),
      ] },
      { label: 'Tabs', submenu: [
        { label: 'Next tab', accelerator: 'Ctrl+Tab', click: A('nextTab') },
        { label: 'Previous tab', accelerator: 'Ctrl+Shift+Tab', click: A('prevTab') },
        { label: 'Bookmark this page', accelerator: 'CmdOrCtrl+D', click: A('bookmark') },
        { label: 'Bookmarks', accelerator: 'CmdOrCtrl+Shift+O', click: A('bookmarks') },
        { label: 'History', accelerator: 'CmdOrCtrl+Y', click: A('history') },
        { label: 'Downloads', accelerator: 'CmdOrCtrl+J', click: A('downloads') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: A('settings') },
      ] },
      { role: 'windowMenu' },
    ];
    const keep = (it) => it.label === 'Quit' || /^F11$|Ctrl\+Cmd\+F/.test(it.accelerator || '');
    for (const top of tpl) for (const it of top.submenu || []) if (it.accelerator && !keep(it)) it.registerAccelerator = false;
    Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
  }

  app.whenReady().then(() => {
    // an installed build checks its own files against integrity.json (written by tools/protect.js); if they were changed the Mayfair view will not open Mayfair Cloud
    const integ = app.isPackaged ? PROT.verify(path.resolve(__dirname, '..', '..')) : { ok: true };
    if (!integ.ok) console.error('Mayfair Desktop: installed files do not match the build (' + integ.reason + '): ' + integ.bad.join(', '));
    br = new BrowserService({ dataDir: path.join(app.getPath('userData'), 'mayfair-desktop'), version: pkg.version, tampered: integ.ok ? null : integ });
    fs.mkdirSync(br.dir, { recursive: true });
    br.onSettingsChanged = (keys) => {
      const s = br.settings.get();
      if (keys.includes('launchAtLogin')) applyLoginItem(s.launchAtLogin);
      if (keys.includes('tray')) buildTray(s.tray);
    };
    br.onAppsChanged = () => refreshPinned();
    br.onBadge = (n) => { if (tray) tray.setToolTip(n ? `Mayfair Desktop (${n} new)` : 'Mayfair Desktop'); };
    buildMenu();
    const s = br.settings.get();
    br.start({ hidden: hiddenStart && s.tray });
    buildTray(s.tray);
    refreshPinned();
    if (!app.isPackaged && process.defaultApp) app.setAsDefaultProtocolClient('mayfair', process.execPath, [path.resolve(process.argv[1] || '.')]);
    else app.setAsDefaultProtocolClient('mayfair');
    const feed = (pkg.build && pkg.build.publish && pkg.build.publish[0] && pkg.build.publish[0].url) || '';
    const u = updater.setup({
      app, feedUrl: process.env.MAYFAIR_UPDATE_URL || feed,
      onReady: (v, install) => {
        br.notice('Update ' + v + ' is ready. It installs when you quit.');
        if (Notification.isSupported()) new Notification({ title: 'Mayfair Desktop update ready', body: 'Version ' + v + ' installs when you close the app.' }).show();
        br.installUpdate = install;
      },
    });
    br.updater = u;
    br.home.wc.once('did-finish-load', drain);
    setTimeout(drain, 2500);
    if (process.env.MF_SMOKE && !app.isPackaged) require(process.env.MF_SMOKE_HOOK === 'real' ? '../../tools/smoke-real' : '../../tools/smoke-hook').run(br, app);
  });

  app.on('activate', () => { if (br) br.showWindow(); });
  app.on('will-quit', () => { if (br) br.flushAppSessions(); });
  app.on('before-quit', () => { if (br) { br.quitting = true; br.icons.stop(); br.flushAll(); } });
  app.on('window-all-closed', () => { if (br && br.quitting) app.quit(); else if (!br || !br.settings.get().tray) app.quit(); });
  // Any web contents the app did not create itself (webview, stray windows) is refused.
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (e) => e.preventDefault());
  });
}
