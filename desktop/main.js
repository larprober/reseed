'use strict';

const { app, BrowserWindow, ipcMain, session, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { ChromeSession, findBrowser } = require('./chrome');

/** @type {ChromeSession} */
let chrome = null;

// A muted, sped-up video still counts as a watch. Without this the pane needs a
// real click before anything plays, which breaks unattended sessions.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'reseed.config.json');

/*
 * The embedded pane is used for Instagram only. YouTube goes through a real
 * Chrome (see chrome.js) because Google blocks sign-in from embedded browsers,
 * and defeating that check is not something Reseed does.
 *
 * The version is read off the real engine so it can never drift from what this
 * pane actually is.
 */
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  `Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#0E1116',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0E1116', symbolColor: '#8B95AB', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => win.show());
}

app.whenReady().then(() => {
  // Electron appends its own tokens to the default agent string; this drops
  // them so Instagram serves the same page it serves any desktop Chrome.
  session.fromPartition('persist:reseed-instagram').setUserAgent(CHROME_UA);

  chrome = new ChromeSession(path.join(app.getPath('userData'), 'chrome-profile'));

  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() === 'webview') {
      // Nothing in a training run should be allowed to spawn windows.
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.setAudioMuted(true);
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Leaving an orphaned Chrome behind would hold the profile lock and break the
// next launch.
app.on('before-quit', () => {
  if (chrome) chrome.close();
});

ipcMain.handle('chrome:status', () => (chrome ? chrome.status() : { available: !!findBrowser() }));

ipcMain.handle('chrome:signin', (_e, startUrl) => chrome.signIn(startUrl));

ipcMain.handle('chrome:launch', (_e, startUrl) => chrome.launch(startUrl));

ipcMain.handle('chrome:navigate', (_e, url) => chrome.navigate(url));

ipcMain.handle('chrome:evaluate', (_e, { code, userGesture }) =>
  chrome.evaluate(code, userGesture));

ipcMain.handle('chrome:url', () => chrome.currentUrl());

ipcMain.handle('chrome:wipe', () => chrome.wipeProfile());

ipcMain.handle('config:load', () => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('config:save', (_e, data) => {
  try {
    fs.writeFileSync(CONFIG_FILE(), JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('session:clear', async (_e, partition) => {
  const target = session.fromPartition(partition);
  await target.clearStorageData();
  return true;
});

ipcMain.handle('shell:open', (_e, url) => {
  if (/^https:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.handle('dialog:confirm', async (_e, { title, message, detail, confirmLabel }) => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [confirmLabel || 'Continue', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: title || 'Reseed',
    message: message || '',
    detail: detail || ''
  });
  return response === 0;
});
