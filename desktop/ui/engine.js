'use strict';

/*
 * Reseed engine.
 *
 * Everything here drives a real, signed-in browser session. There
 * is no API behind it, because neither platform exposes one that can write the
 * signals that actually move a recommendation feed. The engine navigates, waits,
 * and reads the page the same way a person would, only on a timer.
 *
 * Two rules it never breaks:
 *   - It never types a credential and never clicks through a consent or login
 *     wall. It stops and hands the window back to you.
 *   - It only performs a public action (like, subscribe, follow) when that
 *     switch is explicitly on.
 */

const Engine = (() => {

  const URLS = {
    youtube: {
      home: 'https://www.youtube.com/',
      search: (q) => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q),
      item: (id) => 'https://www.youtube.com/watch?v=' + id,
      history: 'https://www.youtube.com/feed/history'
    },
    instagram: {
      home: 'https://www.instagram.com/',
      search: (q) => 'https://www.instagram.com/explore/tags/' + encodeURIComponent(q.replace(/^#/, '')) + '/',
      item: (p) => 'https://www.instagram.com' + p,
      history: 'https://www.instagram.com/your_activity/interactions/likes/'
    }
  };

  let abort = { stopped: false };

  const rand = (lo, hi) => lo + Math.random() * (hi - lo);

  function sleep(ms) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (abort.stopped || Date.now() - started >= ms) return resolve();
        setTimeout(tick, Math.min(200, ms - (Date.now() - started)));
      };
      tick();
    });
  }

  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* ---------------- page access ---------------- */

  /*
   * A driver is anything that can navigate and run JavaScript. Instagram uses
   * the embedded pane; YouTube uses a real Chrome over the DevTools Protocol,
   * because Google blocks sign-in from embedded browsers. Everything below this
   * point is written against the two methods, so neither path is a special case.
   */

  function webviewDriver(wv) {
    return {
      kind: 'webview',
      async evaluate(code, gesture) {
        try {
          return await wv.executeJavaScript(code, !!gesture);
        } catch {
          return null; // the page navigated out from under us; the caller retries
        }
      },
      navigate(url) {
        return new Promise((resolve) => {
          let settled = false;
          const finish = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            wv.removeEventListener('did-finish-load', onLoad);
            wv.removeEventListener('did-fail-load', onFail);
            resolve(ok);
          };
          const onLoad = () => finish(true);
          const onFail = (e) => {
            if (e.errorCode === -3) return; // ERR_ABORTED: a redirect, not a failure
            finish(false);
          };
          const timer = setTimeout(() => finish(false), 35000);
          wv.addEventListener('did-finish-load', onLoad);
          wv.addEventListener('did-fail-load', onFail);
          Promise.resolve(wv.loadURL(url)).catch(() => finish(false));
        });
      }
    };
  }

  function chromeDriver() {
    return {
      kind: 'chrome',
      evaluate: (code, gesture) => window.reseed.chrome.evaluate(code, !!gesture),
      navigate: (url) => window.reseed.chrome.navigate(url)
    };
  }

  async function waitFor(driver, expression, timeout) {
    const deadline = Date.now() + (timeout || 15000);
    while (Date.now() < deadline) {
      if (abort.stopped) return false;
      if (await driver.evaluate(expression)) return true;
      await sleep(350);
    }
    return false;
  }

  /* ---------------- injected snippets ---------------- */

  const SNIP = {
    probe: `(() => ({
      href: location.href,
      host: location.host,
      title: document.title,
      login: !!document.querySelector('input[type="password"], input[name="username"]'),
      captcha: /recaptcha|are you a robot|challenge/i.test(document.body ? document.body.innerText.slice(0, 3000) : '')
    }))()`,

    // Both look for evidence of being signed OUT rather than evidence of being
    // signed in. A missed positive would block a run that would have worked;
    // a missed negative only costs one wasted round.
    signedInYouTube: `(() => !document.querySelector(
      'a[href*="ServiceLogin"], a[href*="accounts.google.com/signin"]'
    ))()`,

    signedInInstagram: `(() => !document.querySelector('input[name="username"]'))()`,

    // Results are client-rendered and can take several seconds. Waiting for
    // them beats a fixed sleep, which harvested an empty page on a slow load.
    resultsReady: {
      youtube: `(() => document.querySelectorAll('a[href*="/watch?v="]').length > 2)()`,
      instagram: `(() => document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').length > 2)()`
    },

    scroll: (times) => `(async () => {
      const nap = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < ${times}; i++) {
        window.scrollBy({ top: window.innerHeight * 0.82, behavior: 'smooth' });
        await nap(650 + Math.random() * 550);
      }
      return document.documentElement.scrollHeight;
    })()`,

    // Prefer the DOM, fall back to the id blob in the server-rendered payload
    // when YouTube swaps its element names again.
    harvestYouTube: `(() => {
      const out = [];
      const seen = new Set();
      const add = (id, title) => {
        if (!id || !/^[\\w-]{11}$/.test(id) || seen.has(id)) return;
        seen.add(id);
        out.push({ id, title: (title || '').trim().slice(0, 90) });
      };
      document.querySelectorAll('ytd-video-renderer a#video-title, a#video-title-link, a#video-title').forEach(a => {
        try {
          const u = new URL(a.href, location.origin);
          add(u.searchParams.get('v'), a.getAttribute('title') || a.textContent);
        } catch (e) {}
      });
      if (out.length < 3) {
        (document.documentElement.innerHTML.match(/"videoId":"[\\w-]{11}"/g) || [])
          .forEach(s => add(s.slice(11, -1), ''));
      }
      return out.slice(0, 40);
    })()`,

    harvestInstagram: `(() => {
      const out = [];
      const seen = new Set();
      document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').forEach(a => {
        const m = (a.getAttribute('href') || '').match(/^\\/(?:p|reel)\\/[^/?#]+\\//);
        if (m && !seen.has(m[0])) { seen.add(m[0]); out.push(m[0]); }
      });
      return out.slice(0, 40);
    })()`,

    // One tick of a watch. Returns whether real content (not an ad) is running,
    // so the caller can decline to count ad seconds as watch time.
    watchTick: `(() => {
      const player = document.querySelector('.html5-video-player');
      const ad = !!(player && player.classList.contains('ad-showing'));
      const skip = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern');
      if (skip) { try { skip.click(); } catch (e) {} }
      const nag = document.querySelector('yt-confirm-dialog-renderer #confirm-button button');
      if (nag) { try { nag.click(); } catch (e) {} }
      const v = document.querySelector('video');
      if (!v) return { ok: false, ad };
      v.muted = true;
      if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      return { ok: true, ad, t: v.currentTime || 0, dur: v.duration || 0, paused: v.paused };
    })()`,

    playInstagram: `(() => {
      const vids = [...document.querySelectorAll('video')];
      vids.forEach(v => { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); });
      return vids.length;
    })()`,

    // "Beğenme" (dislike) contains "beğen", so the Turkish label needs the
    // negative lookahead or every like turns into a dislike.
    likeYouTube: `(() => {
      const buttons = [...document.querySelectorAll('button')];
      const btn = buttons.find(b => {
        const l = b.getAttribute('aria-label') || '';
        if (!l) return false;
        return /like this video/i.test(l) || (/beğen/i.test(l) && !/beğenme/i.test(l));
      });
      if (!btn) return 'missing';
      if (btn.getAttribute('aria-pressed') === 'true') return 'already';
      btn.click();
      return 'liked';
    })()`,

    subscribeYouTube: `(() => {
      const host = document.querySelector('ytd-subscribe-button-renderer, #subscribe-button');
      if (!host) return 'missing';
      const btn = host.querySelector('button');
      if (!btn) return 'missing';
      const label = ((btn.getAttribute('aria-label') || '') + ' ' + (btn.textContent || '')).trim();
      if (/subscribed|abone olundu|unsubscribe|abonelikten/i.test(label)) return 'already';
      if (!/subscribe|abone ol/i.test(label)) return 'missing';
      btn.click();
      return 'subscribed';
    })()`,

    likeInstagram: `(() => {
      const svg = [...document.querySelectorAll('svg[aria-label]')]
        .find(s => /^(like|beğen)$/i.test((s.getAttribute('aria-label') || '').trim()));
      if (!svg) return 'missing';
      const btn = svg.closest('div[role="button"], button');
      if (!btn) return 'missing';
      btn.click();
      return 'liked';
    })()`,

    followInstagram: `(() => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => /^(follow|takip et)$/i.test((b.textContent || '').trim()));
      if (!btn) return 'missing';
      btn.click();
      return 'followed';
    })()`,

    prune: (words, cap) => `(async () => {
      const nap = (ms) => new Promise(r => setTimeout(r, ms));
      const words = ${JSON.stringify(words)};
      if (!words.length) return { done: 0, removed: [], reason: 'no-words' };
      const cards = [...document.querySelectorAll('ytd-rich-item-renderer')];
      const removed = [];
      for (const card of cards) {
        if (removed.length >= ${cap}) break;
        const text = (card.innerText || '').toLowerCase();
        if (!text || !words.some(w => text.includes(w))) continue;
        const menu = card.querySelector('ytd-menu-renderer button, button[aria-label*="Action menu"], button[aria-label*="İşlem menüsü"]');
        if (!menu) continue;
        card.scrollIntoView({ block: 'center' });
        await nap(400);
        menu.click();
        await nap(700);
        const item = [...document.querySelectorAll('ytd-menu-service-item-renderer')]
          .find(i => /not interested|ilgilenmiyorum/i.test(i.innerText || ''));
        if (item) {
          item.click();
          removed.push((card.innerText || '').split('\\n')[0].slice(0, 70));
          await nap(800);
        } else {
          document.body.click();
          await nap(350);
        }
      }
      return { done: removed.length, removed };
    })()`
  };

  /* ---------------- guards ---------------- */

  async function checkGate(driver, platform) {
    const where = driver.kind === 'chrome' ? 'the Chrome window' : 'the pane';
    const p = await driver.evaluate(SNIP.probe);
    if (!p) return null;
    if (/consent\.(youtube|google)\./i.test(p.host)) {
      return 'A consent screen is up. Answer it yourself in ' + where + ', then run again.';
    }
    if (/accounts\.google\./i.test(p.host) || p.login) {
      return 'That session is signed out. Sign in in ' + where + ', then run again.';
    }
    if (p.captcha) {
      return 'The site is showing a challenge. Clear it yourself in ' + where + ', then run again.';
    }
    const signedIn = await driver.evaluate(
      platform === 'youtube' ? SNIP.signedInYouTube : SNIP.signedInInstagram
    );
    if (signedIn === false) {
      return 'Not signed in. Sign in in ' + where + ' first — a signed-out session teaches nothing.';
    }
    return null;
  }

  /* ---------------- one item ---------------- */

  async function watchYouTube(driver, video, cfg, io) {
    const ok = await driver.navigate(URLS.youtube.item(video.id));
    if (!ok) { io.log('warn', 'Could not open ' + video.id); return 0; }
    if (!(await waitFor(driver, `(() => !!document.querySelector('video'))()`, 18000))) {
      io.log('warn', 'No player appeared for ' + video.id);
      return 0;
    }

    const target = Math.round(cfg.dwell * (cfg.pacing ? rand(0.82, 1.3) : 1));
    const label = video.title ? video.title.slice(0, 58) : video.id;
    io.log('step', 'Watching ' + label + ' — ' + target + 's');

    let watched = 0;
    let adSeen = false;
    while (watched < target && !abort.stopped) {
      const tick = await driver.evaluate(SNIP.watchTick, true);
      if (!tick || !tick.ok) break;
      if (tick.ad) adSeen = true;
      else watched += 2;
      // A short video that has run to the end has given all the signal it has.
      if (!tick.ad && tick.dur > 0 && tick.t >= tick.dur - 1.2) break;
      await sleep(2000);
    }
    if (adSeen) io.log('info', 'Sat through an ad — those seconds were not counted');

    if (cfg.like) {
      const r = await driver.evaluate(SNIP.likeYouTube, true);
      if (r === 'liked') io.log('good', 'Liked it');
      else if (r === 'missing') io.log('warn', 'Like button not found');
    }
    if (cfg.follow) {
      const r = await driver.evaluate(SNIP.subscribeYouTube, true);
      if (r === 'subscribed') io.log('good', 'Subscribed to the channel');
    }
    return watched;
  }

  async function viewInstagram(driver, permalink, cfg, io) {
    const ok = await driver.navigate(URLS.instagram.item(permalink));
    if (!ok) { io.log('warn', 'Could not open ' + permalink); return 0; }
    await sleep(1600);
    await driver.evaluate(SNIP.playInstagram, true);

    const target = Math.round(cfg.dwell * (cfg.pacing ? rand(0.82, 1.3) : 1));
    io.log('step', 'Viewing ' + permalink + ' — ' + target + 's');

    let watched = 0;
    while (watched < target && !abort.stopped) {
      await sleep(2000);
      watched += 2;
      if (watched % 8 === 0) await driver.evaluate(SNIP.playInstagram, true);
    }

    if (cfg.like) {
      const r = await driver.evaluate(SNIP.likeInstagram, true);
      if (r === 'liked') io.log('good', 'Liked it');
    }
    if (cfg.follow) {
      const r = await driver.evaluate(SNIP.followInstagram, true);
      if (r === 'followed') io.log('good', 'Followed the account');
    }
    return watched;
  }

  /* ---------------- the run ---------------- */

  async function run(driver, cfg, io) {
    abort = { stopped: false };

    const urls = URLS[cfg.platform];
    const tally = { items: 0, seconds: 0, searches: 0, pruned: 0, tags: cfg.tags.length };

    const perRound = cfg.tags.length * (1 + cfg.perTag) + 1;
    const totalSteps = cfg.rounds * perRound + (cfg.prune ? 1 : 0);
    let step = 0;
    const advance = (text) => {
      step++;
      io.progress(Math.min(1, step / totalSteps));
      if (text) io.status(text);
    };

    io.status('Checking the session');
    const gate = await checkGate(driver, cfg.platform);
    if (gate) return { stopped: true, reason: gate, tally };

    io.log('step', 'Reseeding ' + cfg.platform + ' with ' + cfg.tags.length +
      ' tag' + (cfg.tags.length === 1 ? '' : 's') + ' over ' + cfg.rounds +
      ' round' + (cfg.rounds === 1 ? '' : 's'));

    if (cfg.prune && cfg.platform === 'youtube') {
      io.status('Pruning the home feed');
      advance();
      await driver.navigate(urls.home);
      await sleep(2500);
      await driver.evaluate(SNIP.scroll(3));
      const result = await driver.evaluate(SNIP.prune(cfg.muteWords, 25), true);
      if (result && result.reason === 'no-words') {
        io.log('warn', 'Prune is on but no words were given — skipped');
      } else if (result) {
        tally.pruned = result.done;
        io.log(result.done ? 'good' : 'info', 'Pruned ' + result.done + ' card' +
          (result.done === 1 ? '' : 's') + ' from the home feed');
        (result.removed || []).forEach((t) => io.log('info', '  removed: ' + t));
      }
    }

    for (let round = 1; round <= cfg.rounds && !abort.stopped; round++) {
      for (const tag of shuffle(cfg.tags)) {
        if (abort.stopped) break;
        io.counter('round ' + round + '/' + cfg.rounds);

        let harvested = [];

        if (cfg.search || cfg.platform === 'instagram') {
          advance('Searching #' + tag);
          io.log('step', 'Searching #' + tag);
          const ok = await driver.navigate(urls.search('#' + tag));
          if (!ok) { io.log('warn', 'Search failed for #' + tag); continue; }
          tally.searches++;
          await waitFor(driver, SNIP.resultsReady[cfg.platform], 18000);
          await sleep(900);

          const gateNow = await checkGate(driver, cfg.platform);
          if (gateNow) return { stopped: true, reason: gateNow, tally };

          if (cfg.platform === 'instagram') await driver.evaluate(SNIP.scroll(2));
          harvested = await driver.evaluate(
            cfg.platform === 'youtube' ? SNIP.harvestYouTube : SNIP.harvestInstagram
          ) || [];
        } else {
          advance('Opening #' + tag);
          const ok = await driver.navigate(urls.search('#' + tag));
          if (!ok) continue;
          await waitFor(driver, SNIP.resultsReady[cfg.platform], 18000);
          await sleep(900);
          harvested = await driver.evaluate(SNIP.harvestYouTube) || [];
        }

        if (!harvested.length) {
          io.log('warn', 'Nothing came back for #' + tag);
          continue;
        }

        // Draw from the top of the results, but not always the same few, or the
        // account keeps rewatching one video across rounds.
        const pool = harvested.slice(0, Math.max(cfg.perTag * 3, 8));
        const picks = shuffle(pool).slice(0, cfg.perTag);

        for (const pick of picks) {
          if (abort.stopped) break;
          advance('#' + tag + ' — item ' + (picks.indexOf(pick) + 1) + '/' + picks.length);
          const seconds = cfg.platform === 'youtube'
            ? await watchYouTube(driver, pick, cfg, io)
            : await viewInstagram(driver, pick, cfg, io);
          if (seconds > 0) { tally.items++; tally.seconds += seconds; }
          if (cfg.pacing) await sleep(rand(900, 2400));
        }
      }

      if (abort.stopped) break;
      advance('Letting the feed re-rank');
      io.log('step', 'Round ' + round + ' done — reloading the feed');
      await driver.navigate(urls.home);
      await sleep(2500);
      await driver.evaluate(SNIP.scroll(2));
    }

    io.progress(1);
    return { stopped: abort.stopped, reason: null, tally };
  }

  return {
    URLS,
    run,
    webviewDriver,
    chromeDriver,
    stop() { abort.stopped = true; },
    get aborted() { return abort.stopped; }
  };
})();
