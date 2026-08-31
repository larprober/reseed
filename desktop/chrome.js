'use strict';

/*
 * Drives a real Chrome (or Edge) over the DevTools Protocol.
 *
 * Google blocks sign-in from embedded browsers, and rightly so — that check is
 * what stops an app from wrapping a Google login and reading the password. So
 * Reseed does not embed one for YouTube. It launches the browser you already
 * have, in its own separate profile, and drives it. Nothing is spoofed, because
 * nothing needs to be: it genuinely is Chrome.
 *
 * The profile lives under Reseed's own app data, so signing in here does not
 * touch your everyday Chrome profile, and signing out here does not sign you
 * out there.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const CANDIDATES = [
  ['Chrome', ['PROGRAMFILES', 'Google/Chrome/Application/chrome.exe']],
  ['Chrome', ['PROGRAMFILES(X86)', 'Google/Chrome/Application/chrome.exe']],
  ['Chrome', ['LOCALAPPDATA', 'Google/Chrome/Application/chrome.exe']],
  ['Edge', ['PROGRAMFILES(X86)', 'Microsoft/Edge/Application/msedge.exe']],
  ['Edge', ['PROGRAMFILES', 'Microsoft/Edge/Application/msedge.exe']]
];

function findBrowser() {
  for (const [name, [envKey, tail]] of CANDIDATES) {
    const base = process.env[envKey];
    if (!base) continue;
    const full = path.join(base, tail);
    if (fs.existsSync(full)) return { name, path: full };
  }
  return null;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const NO_BROWSER =
  'No Chrome or Edge found on this machine. Reseed drives one of those for ' +
  'YouTube — install Chrome and try again.';

function getJson(port, route) {
  return new Promise((resolve, reject) => {
    // No Host override: Chrome's DevTools endpoint rejects a Host header that
    // is not an IP or localhost *with* the port, and Node's default is correct.
    const req = http.get(
      { host: '127.0.0.1', port, path: route },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

class ChromeSession {
  constructor(profileDir) {
    this.profileDir = profileDir;
    this.proc = null;
    this.mode = null; // 'signin' | 'drive'
    this.ws = null;
    this.port = null;
    this.browser = null;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.lastUrl = '';
  }

  get connected() {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  status() {
    if (!this.browser) this.browser = findBrowser();
    return {
      browser: this.browser ? this.browser.name : null,
      browserPath: this.browser ? this.browser.path : null,
      available: !!this.browser,
      mode: this.proc ? this.mode : null,
      signInOpen: this.mode === 'signin' && !!this.proc,
      connected: this.connected,
      url: this.lastUrl
    };
  }

  /*
   * Sign-in window: a completely ordinary Chrome, no debugging port.
   *
   * That matters. Chrome sets navigator.webdriver to true whenever
   * --remote-debugging-port is present — attached or not — and that flag is
   * exactly the kind of thing a sign-in flow refuses. So the browser you type
   * your password into is never the automated one. Only the run gets the port,
   * and by then the session cookie is already on disk.
   */
  async signIn(startUrl) {
    const browser = findBrowser();
    if (!browser) return { ok: false, error: NO_BROWSER };
    this.browser = browser;

    await this.shutdown();
    fs.mkdirSync(this.profileDir, { recursive: true });

    this.mode = 'signin';
    this.proc = spawn(
      browser.path,
      [
        `--user-data-dir=${this.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--new-window',
        startUrl
      ],
      { detached: false, stdio: 'ignore' }
    );
    this.proc.on('exit', () => {
      this.proc = null;
      this.mode = null;
    });
    return { ok: true };
  }

  async launch(startUrl) {
    if (this.connected) {
      await this.navigate(startUrl);
      return { ok: true };
    }

    // One Chrome per profile directory. The sign-in window has to go first, and
    // the user closes it themselves so the cookie jar is flushed cleanly.
    if (this.mode === 'signin' && this.proc) {
      return {
        ok: false,
        error:
          'Close the sign-in Chrome window first. Reseed opens its own window ' +
          'to run in, and Chrome only allows one at a time per profile.'
      };
    }

    this.browser = findBrowser();
    if (!this.browser) return { ok: false, error: NO_BROWSER };

    fs.mkdirSync(this.profileDir, { recursive: true });
    // Chrome writes the port it actually took here; asking for 0 avoids
    // colliding with anything already listening.
    const portFile = path.join(this.profileDir, 'DevToolsActivePort');
    try {
      fs.unlinkSync(portFile);
    } catch { /* first run */ }

    this.proc = spawn(
      this.browser.path,
      [
        '--remote-debugging-port=0',
        `--user-data-dir=${this.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--no-service-autorun',
        '--disable-background-networking',
        '--new-window',
        startUrl
      ],
      { detached: false, stdio: 'ignore' }
    );
    this.mode = 'drive';
    this.proc.on('exit', () => {
      this.proc = null;
      this.mode = null;
      this.closeSocket();
    });

    const port = await this.readPort(portFile);
    if (!port) {
      return {
        ok: false,
        error:
          'Chrome started but never reported a debugging port. If a Chrome ' +
          'window is already open from this profile, close it and try again.'
      };
    }
    this.port = port;

    const attached = await this.attach();
    if (!attached) {
      return { ok: false, error: 'Could not attach to the Chrome tab.' };
    }
    return { ok: true };
  }

  async readPort(portFile) {
    for (let i = 0; i < 60; i++) {
      try {
        const first = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
        const port = parseInt(first, 10);
        if (port > 0) return port;
      } catch { /* not written yet */ }
      await wait(250);
    }
    return null;
  }

  async attach() {
    for (let i = 0; i < 40; i++) {
      try {
        const targets = await getJson(this.port, '/json/list');
        const page = targets.find(
          (t) => t.type === 'page' && t.webSocketDebuggerUrl &&
            !t.url.startsWith('devtools://')
        );
        if (page) {
          await this.openSocket(page.webSocketDebuggerUrl);
          await this.send('Page.enable');
          this.lastUrl = page.url;
          return true;
        }
      } catch { /* browser still coming up */ }
      await wait(250);
    }
    return false;
  }

  openSocket(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      ws.on('open', () => {
        this.ws = ws;
        resolve();
      });
      ws.on('error', reject);
      ws.on('close', () => {
        if (this.ws === ws) this.ws = null;
      });
      ws.on('message', (raw) => this.onMessage(raw));
    });
  }

  onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Page.frameNavigated' && msg.params.frame && !msg.params.frame.parentId) {
      this.lastUrl = msg.params.frame.url;
    }
    for (const waiter of this.waiters.slice()) {
      if (waiter.method === msg.method) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(msg.params);
      }
    }
  }

  send(method, params) {
    if (!this.connected) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(method + ' timed out'));
        }
      }, 40000);
    });
  }

  once(method, timeout) {
    return new Promise((resolve) => {
      const waiter = { method, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) {
          this.waiters.splice(at, 1);
          resolve(null);
        }
      }, timeout || 35000);
    });
  }

  async navigate(url) {
    if (!this.connected && !(await this.attach())) return false;
    const loaded = this.once('Page.loadEventFired', 35000);
    try {
      await this.send('Page.navigate', { url });
    } catch {
      return false;
    }
    await loaded;
    this.lastUrl = url;
    return true;
  }

  /*
   * awaitPromise lets the same async snippets the embedded pane runs work here
   * unchanged, and returnByValue brings the result back as plain JSON.
   */
  async evaluate(expression, userGesture) {
    if (!this.connected) return null;
    try {
      const res = await this.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: !!userGesture
      });
      if (res.exceptionDetails) return null;
      return res.result ? res.result.value : null;
    } catch {
      return null;
    }
  }

  async currentUrl() {
    const url = await this.evaluate('location.href');
    if (typeof url === 'string') this.lastUrl = url;
    return this.lastUrl;
  }

  closeSocket() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch { /* already gone */ }
      this.ws = null;
    }
    for (const { reject } of this.pending.values()) reject(new Error('disconnected'));
    this.pending.clear();
  }

  /** Kills whatever is running and waits for the profile lock to be released. */
  async shutdown() {
    if (!this.proc) return;
    const proc = this.proc;
    this.close();
    for (let i = 0; i < 40 && proc.exitCode === null; i++) await wait(150);
    await wait(400);
  }

  close() {
    this.closeSocket();
    if (this.proc) {
      try {
        this.proc.kill();
      } catch { /* already exited */ }
      this.proc = null;
    }
  }

  /** Signs this profile out by deleting it. The user's own Chrome is untouched. */
  async wipeProfile() {
    await this.shutdown();
    try {
      fs.rmSync(this.profileDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { ChromeSession, findBrowser };
