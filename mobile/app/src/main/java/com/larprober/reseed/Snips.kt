package com.larprober.reseed

/**
 * The JavaScript Reseed injects into the signed-in session.
 *
 * These are tuned for the mobile sites (m.youtube.com, instagram.com on a phone
 * user agent), which use different element names from the desktop ones. Every
 * snippet degrades to a harmless return value rather than throwing, because the
 * page can navigate out from under an injection at any moment.
 *
 * Label matching covers English and Turkish. Note the negative lookahead on
 * "beğen": Turkish for dislike is "beğenme", so a naive match turns every like
 * into a dislike.
 */
object Snips {

    /** Kotlin raw strings treat `$` as a template start; this is a literal one. */
    private const val D = "$"

    val PROBE = """
        (function () {
          return {
            href: location.href,
            host: location.host,
            login: !!document.querySelector('input[type="password"], input[name="username"]'),
            captcha: /recaptcha|are you a robot|unusual traffic/i.test(
              document.body ? document.body.innerText.slice(0, 3000) : '')
          };
        })()
    """.trimIndent()

    /**
     * Both of these look for evidence of being signed OUT rather than evidence
     * of being signed in. A missed positive would block a run that would have
     * worked; a missed negative only costs one wasted round.
     */
    val SIGNED_IN_YOUTUBE = """
        (function () {
          return !document.querySelector(
            'a[href*="ServiceLogin"], a[href*="accounts.google.com/signin"], ' +
            '.mobile-topbar-header-sign-in-button');
        })()
    """.trimIndent()

    val SIGNED_IN_INSTAGRAM = """
        (function () {
          return !document.querySelector('input[name="username"]');
        })()
    """.trimIndent()

    fun scroll(times: Int) = """
        (async function () {
          var nap = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
          for (var i = 0; i < $times; i++) {
            window.scrollBy({ top: window.innerHeight * 0.82, behavior: 'smooth' });
            await nap(650 + Math.random() * 550);
          }
          return document.documentElement.scrollHeight;
        })()
    """.trimIndent()

    /** Prefers real links, falls back to the id blob in the page payload. */
    val HARVEST_YOUTUBE = """
        (function () {
          var out = [], seen = {};
          function add(id, title) {
            if (!id || seen[id] || !/^[\w-]{11}$D/.test(id)) return;
            seen[id] = 1;
            out.push({ id: id, title: (title || '').trim().slice(0, 90) });
          }
          var links = document.querySelectorAll('a[href*="/watch?v="]');
          for (var i = 0; i < links.length; i++) {
            try {
              var u = new URL(links[i].href, location.origin);
              add(u.searchParams.get('v'),
                  links[i].getAttribute('aria-label') || links[i].textContent);
            } catch (e) {}
          }
          if (out.length < 3) {
            var m = document.documentElement.innerHTML.match(/"videoId":"[\w-]{11}"/g) || [];
            for (var j = 0; j < m.length; j++) add(m[j].slice(11, -1), '');
          }
          return out.slice(0, 40);
        })()
    """.trimIndent()

    val HARVEST_INSTAGRAM = """
        (function () {
          var out = [], seen = {};
          var links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
          for (var i = 0; i < links.length; i++) {
            var m = (links[i].getAttribute('href') || '').match(/^\/(?:p|reel)\/[^\/?#]+\//);
            if (m && !seen[m[0]]) { seen[m[0]] = 1; out.push(m[0]); }
          }
          return out.slice(0, 40);
        })()
    """.trimIndent()

    /**
     * One tick of a watch. Reports whether real content (not an ad) is running,
     * so the caller can decline to count ad seconds as watch time.
     */
    val WATCH_TICK = """
        (function () {
          var player = document.querySelector('.html5-video-player');
          var ad = !!(player && player.className.indexOf('ad-showing') >= 0) ||
                   !!document.querySelector('.ytp-ad-player-overlay');
          var skip = document.querySelector(
            '.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern');
          if (skip) { try { skip.click(); } catch (e) {} }
          var v = document.querySelector('video');
          if (!v) return { ok: false, ad: ad };
          v.muted = true;
          if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
          return { ok: true, ad: ad, t: v.currentTime || 0, dur: v.duration || 0 };
        })()
    """.trimIndent()

    val PLAY_INSTAGRAM = """
        (function () {
          var vids = document.querySelectorAll('video');
          for (var i = 0; i < vids.length; i++) {
            vids[i].muted = true;
            var p = vids[i].play();
            if (p && p.catch) p.catch(function () {});
          }
          return vids.length;
        })()
    """.trimIndent()

    val LIKE_YOUTUBE = """
        (function () {
          var btns = document.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            var l = btns[i].getAttribute('aria-label') || '';
            if (!l) continue;
            var isLike = /like this video/i.test(l) ||
                         (/beğen/i.test(l) && !/beğenme/i.test(l));
            if (!isLike) continue;
            if (btns[i].getAttribute('aria-pressed') === 'true') return 'already';
            btns[i].click();
            return 'liked';
          }
          return 'missing';
        })()
    """.trimIndent()

    val SUBSCRIBE_YOUTUBE = """
        (function () {
          var btns = document.querySelectorAll('button, tp-yt-paper-button');
          for (var i = 0; i < btns.length; i++) {
            var label = ((btns[i].getAttribute('aria-label') || '') + ' ' +
                         (btns[i].textContent || '')).trim();
            if (/subscribed|abone olundu|unsubscribe|abonelikten/i.test(label)) return 'already';
          }
          for (var j = 0; j < btns.length; j++) {
            var t = (btns[j].textContent || '').trim();
            if (/^(subscribe|abone ol)$D/i.test(t)) { btns[j].click(); return 'subscribed'; }
          }
          return 'missing';
        })()
    """.trimIndent()

    val LIKE_INSTAGRAM = """
        (function () {
          var svgs = document.querySelectorAll('svg[aria-label]');
          for (var i = 0; i < svgs.length; i++) {
            var l = (svgs[i].getAttribute('aria-label') || '').trim();
            if (!/^(like|beğen)$D/i.test(l)) continue;
            var btn = svgs[i].closest('div[role="button"], button');
            if (!btn) continue;
            btn.click();
            return 'liked';
          }
          return 'missing';
        })()
    """.trimIndent()

    val FOLLOW_INSTAGRAM = """
        (function () {
          var btns = document.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            var t = (btns[i].textContent || '').trim();
            if (/^(follow|takip et)$D/i.test(t)) { btns[i].click(); return 'followed'; }
          }
          return 'missing';
        })()
    """.trimIndent()
}
