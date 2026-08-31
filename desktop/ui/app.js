'use strict';

const $ = (id) => document.getElementById(id);

const PLATFORMS = {
  youtube: {
    label: 'YouTube',
    // Google blocks sign-in from embedded browsers. Rather than defeating that
    // check, YouTube runs in the user's own Chrome, driven over CDP.
    session: 'chrome',
    followLabel: 'Subscribe to channels',
    likeNote: 'A public action on someone else’s video',
    tagHint: 'Each tag becomes a search, then a real watch on what it finds.',
    canPrune: true,
    scrubNote: 'New tags grow much faster once the old watch history stops voting. ' +
      'This opens the page. The clearing is yours to click.'
  },
  instagram: {
    label: 'Instagram',
    session: 'pane',
    followLabel: 'Follow the accounts',
    likeNote: 'A public action on someone else’s post',
    tagHint: 'Each tag opens its hashtag page, then dwells on posts from it.',
    canPrune: false,
    scrubNote: 'Instagram has no watch-history switch. What it does expose is the ' +
      'list of things you have liked — that list is a live input to Explore.'
  }
};

const state = {
  platform: 'youtube',
  tags: { youtube: [], instagram: [] },
  running: false,
  chrome: { available: false, connected: false, browser: null, url: '' }
};

const pane = $('wv-instagram');

/* ---------------- drivers ---------------- */

function activeDriver() {
  return PLATFORMS[state.platform].session === 'chrome'
    ? Engine.chromeDriver()
    : Engine.webviewDriver(pane);
}

function usesChrome() {
  return PLATFORMS[state.platform].session === 'chrome';
}

/* ---------------- chrome session ---------------- */

async function pollChrome() {
  try {
    const status = await window.reseed.chrome.status();
    state.chrome = Object.assign(state.chrome, status);
  } catch {
    return;
  }
  if (!usesChrome()) return;

  const box = $('chromeState');
  const text = $('chromeStateText');
  const launch = $('chromeLaunch');

  const label = launch.querySelector('span');
  const hint = $('chromeHint');

  if (!state.chrome.available) {
    box.dataset.state = 'missing';
    text.textContent = 'No Chrome or Edge found on this machine.';
    launch.disabled = true;
    hint.textContent = 'Reseed drives one of those for YouTube. Install Chrome and reopen.';
  } else if (state.chrome.signInOpen) {
    box.dataset.state = 'idle';
    text.textContent = 'Sign-in window is open.';
    label.textContent = 'Reopen the sign-in window';
    launch.disabled = false;
    hint.textContent =
      'Sign into YouTube in that window, then close it. Chrome allows one window ' +
      'per profile, so Reseed opens its own when you run.';
  } else if (state.chrome.connected) {
    box.dataset.state = 'ready';
    text.textContent = state.chrome.browser + ' is open and attached.';
    label.textContent = 'Sign in again';
    launch.disabled = false;
    hint.textContent = 'Leave that window open while a run is going.';
  } else {
    box.dataset.state = 'idle';
    text.textContent = state.chrome.browser + ' found. Nothing open right now.';
    label.textContent = 'Sign in to YouTube';
    launch.disabled = false;
    hint.textContent =
      'Reseed opens its own Chrome window when you press run. Sign in first if ' +
      'you have not already.';
  }

  $('urlbar').textContent = state.chrome.connected
    ? (state.chrome.url || 'youtube.com')
    : (state.chrome.signInOpen ? 'signing in' : 'no Chrome session');
}

/*
 * Sign-in and running are deliberately two different Chrome windows. Chrome
 * turns on navigator.webdriver whenever a debugging port is open, so the window
 * you type a password into never has one.
 */
async function signInChrome() {
  const launch = $('chromeLaunch');
  launch.disabled = true;
  $('chromeStateText').textContent = 'Opening Chrome…';
  const result = await window.reseed.chrome.signIn(Engine.URLS.youtube.home);
  launch.disabled = false;
  if (!result || !result.ok) {
    const message = (result && result.error) || 'Chrome could not be started.';
    log('bad', message);
    showVeil(message);
  } else {
    log('info', 'Sign into YouTube in the Chrome window, then close it.');
  }
  await pollChrome();
}

/* ---------------- chips ---------------- */

function currentTags() {
  return state.tags[state.platform];
}

function renderChips() {
  const box = $('chips');
  box.querySelectorAll('.chip').forEach((n) => n.remove());
  const input = $('tagInput');
  for (const tag of currentTags()) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML =
      '<b><span class="hash">#</span></b>' +
      '<button type="button" aria-label="Remove"><svg class="ico"><use href="#i-x"/></svg></button>';
    chip.querySelector('b').append(tag);
    chip.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      const list = currentTags();
      list.splice(list.indexOf(tag), 1);
      renderChips();
      refresh();
    });
    box.insertBefore(chip, input);
  }
  input.placeholder = currentTags().length ? 'add another' : 'type a tag, press Enter';
}

function addTags(raw) {
  const list = currentTags();
  raw.split(/[,\n]/).forEach((piece) => {
    const tag = piece.trim().replace(/^#+/, '').replace(/\s+/g, '');
    if (tag && !list.includes(tag) && list.length < 40) list.push(tag);
  });
  renderChips();
  refresh();
}

/* ---------------- config ---------------- */

function readConfig() {
  return {
    platform: state.platform,
    tags: currentTags().slice(),
    dwell: +$('dwell').value,
    perTag: +$('perTag').value,
    rounds: +$('rounds').value,
    pacing: true,
    search: $('optSearch').checked,
    like: $('optLike').checked,
    follow: $('optFollow').checked,
    prune: $('optPrune').checked && PLATFORMS[state.platform].canPrune,
    muteWords: $('muteWords').value
      .split(',')
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean)
  };
}

function formatDuration(seconds) {
  if (seconds < 90) return Math.round(seconds) + 's';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return mins + ' min';
  return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
}

function refresh() {
  const cfg = readConfig();
  const meta = PLATFORMS[cfg.platform];

  $('dwellVal').textContent = cfg.dwell + 's';
  $('perTagVal').textContent = cfg.perTag;
  $('roundsVal').textContent = cfg.rounds;

  $('dwellHint').textContent = cfg.platform === 'youtube'
    ? (cfg.dwell < 30
      ? 'Under 30s barely registers as a watch. It still counts, just faintly.'
      : 'Long enough to count as a real watch.')
    : (cfg.dwell < 20
      ? 'Short views are weak signal on Instagram too.'
      : 'A solid dwell for a post or reel.');

  const items = cfg.rounds * cfg.tags.length * cfg.perTag;
  const seconds = cfg.rounds * (cfg.tags.length * (cfg.perTag * (cfg.dwell + 9) + 7) + 9);

  $('est').innerHTML = cfg.tags.length
    ? 'This run opens <b>' + items + '</b> item' + (items === 1 ? '' : 's') +
      ' across <b>' + cfg.tags.length + '</b> tag' + (cfg.tags.length === 1 ? '' : 's') +
      ', and takes roughly <b>' + formatDuration(seconds) + '</b>.'
    : 'Add a tag to see what a run would cost.';

  $('followLabel').textContent = meta.followLabel;
  $('optLike').closest('.sig').querySelector('.sig-text span').textContent = meta.likeNote;
  $('chips').parentElement.querySelector('.hint').textContent = meta.tagHint;
  $('pruneRow').hidden = !meta.canPrune;
  $('pruneSub').hidden = !meta.canPrune || !$('optPrune').checked;
  $('scrubBlock').querySelector('.hint').textContent = meta.scrubNote;

  // Paint every switch straight from its checkbox. A control that takes real
  // actions on someone's feed must not be able to show "off" while armed, and
  // a purely CSS-driven state proved it could.
  document.querySelectorAll('.sig').forEach((row) => {
    const box = row.querySelector('input[type="checkbox"]');
    if (!box) return;
    const on = box.checked;
    row.classList.toggle('is-on', on);
    const state = row.querySelector('.state-on, .state-off');
    if (state) {
      state.className = on ? 'pill state-on' : 'pill state-off';
      state.textContent = on ? 'on' : 'off';
    }
    const icon = row.querySelector('.ico');
    if (icon) icon.style.color = on ? 'var(--accent)' : '';
  });

  $('runBtn').disabled = state.running || cfg.tags.length === 0;
  save();
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.reseed.saveConfig({
      platform: state.platform,
      tags: state.tags,
      dwell: +$('dwell').value,
      perTag: +$('perTag').value,
      rounds: +$('rounds').value,
      search: $('optSearch').checked,
      like: $('optLike').checked,
      follow: $('optFollow').checked,
      prune: $('optPrune').checked,
      muteWords: $('muteWords').value
    });
  }, 400);
}

async function restore() {
  const saved = await window.reseed.loadConfig();
  if (!saved) return;
  if (saved.tags && typeof saved.tags === 'object') {
    state.tags.youtube = saved.tags.youtube || [];
    state.tags.instagram = saved.tags.instagram || [];
  }
  if (saved.dwell) $('dwell').value = saved.dwell;
  if (saved.perTag) $('perTag').value = saved.perTag;
  if (saved.rounds) $('rounds').value = saved.rounds;
  $('optSearch').checked = saved.search !== false;
  $('optLike').checked = !!saved.like;
  $('optFollow').checked = !!saved.follow;
  $('optPrune').checked = !!saved.prune;
  $('muteWords').value = saved.muteWords || '';
  if (saved.platform) setPlatform(saved.platform);
}

/* ---------------- log ---------------- */

function log(kind, message) {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.dataset.kind = kind;
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });
  const text = document.createElement('span');
  text.className = 'log-msg';
  text.textContent = message;
  row.append(time, text);
  const box = $('log');
  box.append(row);
  while (box.children.length > 600) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}

/* ---------------- panes ---------------- */

function setPlatform(platform) {
  state.platform = platform;
  document.querySelectorAll('.seg-btn').forEach((b) => {
    const on = b.dataset.platform === platform;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  });

  const chromeMode = usesChrome();
  $('chromeStage').classList.toggle('is-on', chromeMode);
  pane.classList.toggle('is-on', !chromeMode);

  // The toolbar drives the embedded pane. Chrome has its own controls, and the
  // window is right there, so these would only be a worse copy of them.
  for (const id of ['navBack', 'navReload', 'navHome']) $(id).disabled = chromeMode;

  if (!state.running) {
    $('statusText').textContent = chromeMode
      ? 'Sign in to Chrome on the right, add a few tags, then run.'
      : 'Sign in inside the pane, add a few tags, then run.';
  }

  updateUrlbar();
  renderChips();
  refresh();
  pollChrome();
}

function updateUrlbar() {
  if (usesChrome()) return; // pollChrome owns the bar in Chrome mode
  let url = '';
  try { url = pane.getURL(); } catch { url = ''; }
  $('urlbar').textContent = url || 'loading';
  try {
    $('navBack').disabled = !pane.canGoBack();
  } catch { /* pane not attached yet */ }
}

['did-navigate', 'did-navigate-in-page', 'dom-ready'].forEach((evt) => {
  pane.addEventListener(evt, () => {
    if (!usesChrome()) updateUrlbar();
  });
});

/* ---------------- veil ---------------- */

function showVeil(text) {
  $('veilText').textContent = text;
  $('veil').hidden = false;
}
$('veilDismiss').addEventListener('click', () => { $('veil').hidden = true; });

/* ---------------- run ---------------- */

async function startRun() {
  const cfg = readConfig();
  if (!cfg.tags.length || state.running) return;

  if (usesChrome()) {
    await pollChrome();
    if (!state.chrome.available) {
      const message = 'No Chrome or Edge on this machine. Reseed drives one of those for YouTube.';
      log('warn', message);
      showVeil(message);
      return;
    }
    if (!state.chrome.connected) {
      // Opens the driven window. It refuses while the sign-in window still
      // holds the profile, and says so.
      log('step', 'Opening the Chrome window to run in…');
      const opened = await window.reseed.chrome.launch(Engine.URLS.youtube.home);
      if (!opened || !opened.ok) {
        const message = (opened && opened.error) || 'Chrome could not be started.';
        log('bad', message);
        showVeil(message);
        await pollChrome();
        return;
      }
      await pollChrome();
    }
  }

  const publicActions = [];
  if (cfg.like) publicActions.push('like posts it opens');
  if (cfg.follow) publicActions.push(cfg.platform === 'youtube'
    ? 'subscribe to the channels it lands on'
    : 'follow the accounts it lands on');
  if (cfg.prune) publicActions.push('mark matching home-feed cards "not interested"');

  if (publicActions.length) {
    const okay = await window.reseed.confirm({
      title: 'Reseed',
      message: 'This run will act on your account, not just watch.',
      detail: 'It will ' + publicActions.join(', and ') + '.\n\n' +
        'These are real, visible actions on your ' + PLATFORMS[cfg.platform].label +
        ' account and other people can see them. Watching alone stays private.',
      confirmLabel: 'Run it'
    });
    if (!okay) { log('info', 'Cancelled at the confirmation.'); return; }
  }

  state.running = true;
  $('runBtn').hidden = true;
  $('stopBtn').hidden = false;
  $('logpanel').hidden = false;
  $('logToggle').classList.add('is-open');
  $('veil').hidden = true;
  document.querySelectorAll('.rail input, .seg-btn').forEach((el) => { el.disabled = true; });

  const io = {
    log,
    status: (t) => { $('statusText').textContent = t; },
    counter: (t) => { $('counterText').textContent = t; },
    progress: (p) => { $('progressFill').style.width = (p * 100).toFixed(1) + '%'; }
  };

  let result;
  try {
    result = await Engine.run(activeDriver(), cfg, io);
  } catch (err) {
    log('bad', 'The run hit an error: ' + (err && err.message ? err.message : String(err)));
    result = { stopped: true, reason: null, tally: null };
  }

  state.running = false;
  $('runBtn').hidden = false;
  $('stopBtn').hidden = true;
  document.querySelectorAll('.rail input, .seg-btn').forEach((el) => { el.disabled = false; });
  refresh();

  if (result.reason) {
    io.status('Stopped');
    io.progress(0);
    log('bad', result.reason);
    showVeil(result.reason);
    return;
  }

  const t = result.tally || { items: 0, seconds: 0, searches: 0, pruned: 0 };
  const summary = t.items + ' item' + (t.items === 1 ? '' : 's') + ' watched, ' +
    formatDuration(t.seconds) + ' of dwell, ' + t.searches + ' searches' +
    (t.pruned ? ', ' + t.pruned + ' pruned' : '');

  if (result.stopped) {
    io.status('Stopped early');
    log('warn', 'Stopped by you — ' + summary);
  } else {
    io.status('Done');
    log('good', 'Run complete — ' + summary);
    log('info', 'Give the feed a few hours and another round or two. It drifts, it does not flip.');
  }
  $('counterText').textContent = '';
}

/* ---------------- wiring ---------------- */

$('chips').addEventListener('click', (e) => {
  if (e.target.closest('.chip')) return;
  $('tagInput').focus();
});

$('tagInput').addEventListener('keydown', (e) => {
  const input = e.currentTarget;
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    addTags(input.value);
    input.value = '';
  } else if (e.key === 'Backspace' && !input.value && currentTags().length) {
    currentTags().pop();
    renderChips();
    refresh();
  }
});
$('tagInput').addEventListener('blur', (e) => {
  if (e.target.value.trim()) { addTags(e.target.value); e.target.value = ''; }
});
$('tagInput').addEventListener('paste', (e) => {
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (text && /[,\n]/.test(text)) {
    e.preventDefault();
    addTags(text);
  }
});

document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.running) return;
    setPlatform(btn.dataset.platform);
  });
});

['dwell', 'perTag', 'rounds', 'optSearch', 'optLike', 'optFollow', 'optPrune']
  .forEach((id) => $(id).addEventListener('input', refresh));
$('muteWords').addEventListener('input', save);

$('runBtn').addEventListener('click', startRun);
$('stopBtn').addEventListener('click', () => {
  Engine.stop();
  $('statusText').textContent = 'Stopping after this item';
  log('warn', 'Stop requested — finishing the current item.');
});

$('chromeLaunch').addEventListener('click', signInChrome);

$('navBack').addEventListener('click', () => {
  if (pane.canGoBack()) pane.goBack();
});
$('navReload').addEventListener('click', () => pane.reload());
$('navHome').addEventListener('click', () => pane.loadURL(Engine.URLS.instagram.home));

$('scrubBtn').addEventListener('click', async () => {
  const url = Engine.URLS[state.platform].history;
  if (usesChrome()) {
    if (!state.chrome.connected) {
      log('warn', 'Open the Chrome session first.');
      return;
    }
    await window.reseed.chrome.navigate(url);
  } else {
    pane.loadURL(url);
  }
  log('info', 'Opened the history controls. Nothing is deleted unless you click it.');
});

$('clearBtn').addEventListener('click', async () => {
  const chromeMode = usesChrome();
  const okay = await window.reseed.confirm({
    title: 'Sign out',
    message: chromeMode
      ? 'Delete the Chrome profile Reseed uses for YouTube?'
      : 'Clear the stored Instagram session?',
    detail: chromeMode
      ? 'This closes that Chrome window and deletes the separate profile Reseed keeps ' +
        'for it. Your everyday Chrome profile and your Google account are untouched.'
      : 'This wipes the cookies and storage Reseed keeps for this pane only. ' +
        'Your account itself is untouched, and your browser is untouched.',
    confirmLabel: 'Clear it'
  });
  if (!okay) return;

  if (chromeMode) {
    await window.reseed.chrome.wipe();
    log('info', 'Deleted the Reseed Chrome profile.');
    await pollChrome();
  } else {
    await window.reseed.clearSession('persist:reseed-instagram');
    pane.loadURL(Engine.URLS.instagram.home);
    log('info', 'Cleared the stored session for this pane.');
  }
});

$('logToggle').addEventListener('click', () => {
  const panel = $('logpanel');
  panel.hidden = !panel.hidden;
  $('logToggle').classList.toggle('is-open', !panel.hidden);
});

restore().then(() => {
  renderChips();
  refresh();
  setPlatform(state.platform);
  log('info', 'Reseed ready.');
  setInterval(pollChrome, 2500);
});
