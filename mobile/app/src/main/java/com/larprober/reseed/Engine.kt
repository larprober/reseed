package com.larprober.reseed

import android.annotation.SuppressLint
import android.os.SystemClock
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import kotlin.coroutines.resume
import kotlin.math.min
import kotlin.random.Random

/**
 * How Reseed reaches a platform on Android.
 *
 * DRIVE  — the WebView is the session being trained, so Reseed navigates and
 *          dwells in it directly.
 * HANDOFF— the WebView cannot hold the account (Google refuses sign-in from an
 *          embedded browser), so Reseed only harvests here and hands the videos
 *          to the user's real Chrome, which is already signed in.
 */
enum class Mode { DRIVE, HANDOFF }

enum class Platform(
    val label: String,
    val home: String,
    val history: String,
    val mode: Mode
) {
    YOUTUBE(
        "YouTube",
        "https://m.youtube.com/",
        "https://m.youtube.com/feed/history",
        Mode.HANDOFF
    ),
    INSTAGRAM(
        "Instagram",
        "https://www.instagram.com/",
        "https://www.instagram.com/your_activity/interactions/likes/",
        Mode.DRIVE
    );

    companion object {
        /**
         * YouTube's temporary-playlist endpoint: turns a list of ids into a real
         * playlist that autoplays straight through. Opened in a Custom Tab it
         * runs in the user's own Chrome, against their own account.
         */
        fun queueUrl(ids: List<String>): String =
            "https://www.youtube.com/watch_videos?video_ids=" + ids.joinToString(",")
    }

    fun search(tag: String): String = when (this) {
        YOUTUBE -> "https://m.youtube.com/results?search_query=" + urlEncode("#$tag")
        INSTAGRAM -> "https://www.instagram.com/explore/tags/" +
            urlEncode(tag.removePrefix("#")) + "/"
    }

    fun item(ref: String): String = when (this) {
        YOUTUBE -> "https://m.youtube.com/watch?v=$ref"
        INSTAGRAM -> "https://www.instagram.com$ref"
    }

    private fun urlEncode(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
}

data class RunConfig(
    val platform: Platform,
    val tags: List<String>,
    val dwellSeconds: Int,
    val itemsPerTag: Int,
    val rounds: Int,
    val search: Boolean,
    val like: Boolean,
    val follow: Boolean
)

data class Tally(
    var items: Int = 0,
    var seconds: Int = 0,
    var searches: Int = 0
)

data class RunResult(
    val stopped: Boolean,
    val blockedReason: String?,
    val tally: Tally
)

enum class LogKind { INFO, STEP, GOOD, WARN, BAD }

interface RunListener {
    fun log(kind: LogKind, message: String)
    fun status(text: String)
    fun counter(text: String)
    fun progress(fraction: Float)
}

/**
 * Drives a real, signed-in session in the WebView.
 *
 * There is no API behind this: neither platform exposes one that can write the
 * signals a recommendation feed actually learns from. So the engine navigates,
 * waits and reads the page the way a person would, only on a timer.
 *
 * It never types a credential and never clicks through a login or consent wall
 * — it stops and hands the screen back. It only performs a public action (like,
 * subscribe, follow) when that switch is explicitly on.
 */
class Engine(private val web: WebView) {

    @Volatile
    private var stopping = false

    private val nav = NavClient()

    fun attach() {
        web.webViewClient = nav
    }

    fun stop() {
        stopping = true
    }

    val isStopping: Boolean get() = stopping

    /* ---------------- page access ---------------- */

    private class NavClient : WebViewClient() {
        @Volatile
        var waiter: CompletableDeferred<Boolean>? = null

        var onUrlChanged: ((String) -> Unit)? = null

        override fun onPageFinished(view: WebView, url: String) {
            onUrlChanged?.invoke(url)
            waiter?.complete(true)
            waiter = null
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceError
        ) {
            if (!request.isForMainFrame) return
            waiter?.complete(false)
            waiter = null
        }

        // Everything stays in this WebView; a session that escapes to Chrome is
        // a different cookie jar and teaches the wrong browser.
        override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest
        ): Boolean {
            val scheme = request.url.scheme ?: return true
            return scheme != "http" && scheme != "https"
        }
    }

    fun onUrlChanged(cb: (String) -> Unit) {
        nav.onUrlChanged = cb
    }

    private suspend fun rawEval(js: String): String? =
        suspendCancellableCoroutine { cont ->
            web.post {
                try {
                    web.evaluateJavascript(js) { value ->
                        if (cont.isActive) cont.resume(value)
                    }
                } catch (e: Throwable) {
                    if (cont.isActive) cont.resume(null)
                }
            }
        }

    /**
     * evaluateJavascript hands back a JSON-encoded value, so everything is
     * stringified on the page and unwrapped once here. Anything that throws
     * inside the page comes back as null rather than killing the run.
     */
    private suspend fun evalJson(expression: String): String? {
        val raw = rawEval(
            "(function(){try{return JSON.stringify($expression)}catch(e){return null}})()"
        ) ?: return null
        if (raw == "null") return null
        return try {
            JSONTokener(raw).nextValue() as? String
        } catch (e: Exception) {
            null
        }
    }

    private suspend fun evalObject(expression: String): JSONObject? =
        evalJson(expression)?.let {
            try {
                JSONObject(it)
            } catch (e: Exception) {
                null
            }
        }

    private suspend fun evalArray(expression: String): JSONArray? =
        evalJson(expression)?.let {
            try {
                JSONArray(it)
            } catch (e: Exception) {
                null
            }
        }

    private suspend fun evalString(expression: String): String? = evalJson(expression)

    private suspend fun evalBoolean(expression: String): Boolean? =
        rawEval("(function(){try{return !!($expression)}catch(e){return null}})()")
            ?.let { if (it == "true") true else if (it == "false") false else null }

    /**
     * Android's evaluateJavascript cannot await a promise, so an async snippet
     * is started, its result parked on the page, and polled for.
     */
    private suspend fun evalAsync(expression: String, timeoutMs: Long = 30_000): String? {
        rawEval(
            "(function(){window.__rsDone=false;window.__rsVal=null;" +
                "Promise.resolve($expression)" +
                ".then(function(v){window.__rsVal=v;window.__rsDone=true;})" +
                ".catch(function(){window.__rsDone=true;});return 1})()"
        )
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        while (SystemClock.elapsedRealtime() < deadline) {
            if (stopping) return null
            if (evalBoolean("window.__rsDone") == true) return evalJson("window.__rsVal")
            delay(300)
        }
        return null
    }

    private suspend fun navigate(url: String): Boolean {
        val waiter = CompletableDeferred<Boolean>()
        nav.waiter = waiter
        web.post { web.loadUrl(url) }
        return withTimeoutOrNull(35_000) { waiter.await() } ?: false
    }

    private suspend fun waitFor(expression: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        while (SystemClock.elapsedRealtime() < deadline) {
            if (stopping) return false
            if (evalBoolean(expression) == true) return true
            delay(350)
        }
        return false
    }

    /** Sleep that gives up promptly when the user hits stop. */
    private suspend fun nap(ms: Long) {
        val deadline = SystemClock.elapsedRealtime() + ms
        while (SystemClock.elapsedRealtime() < deadline) {
            if (stopping) return
            delay(min(200L, deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1))
        }
    }

    private fun jitter(seconds: Int): Int =
        (seconds * (0.82 + Random.nextDouble() * 0.48)).toInt().coerceAtLeast(4)

    /* ---------------- guards ---------------- */

    private suspend fun gateReason(platform: Platform): String? {
        val probe = evalObject(Snips.PROBE) ?: return null
        val host = probe.optString("host")
        if (Regex("consent\\.(youtube|google)\\.", RegexOption.IGNORE_CASE).containsMatchIn(host)) {
            return "A consent screen is up. Answer it yourself, then run again."
        }
        if (host.contains("accounts.google.", true) || probe.optBoolean("login")) {
            return "That session is signed out. Sign in here first, then run again."
        }
        if (probe.optBoolean("captcha")) {
            return "The site is showing a challenge. Clear it yourself, then run again."
        }
        val signedIn = evalBoolean(
            if (platform == Platform.YOUTUBE) Snips.SIGNED_IN_YOUTUBE
            else Snips.SIGNED_IN_INSTAGRAM
        )
        if (signedIn == false) {
            return "Not signed in. A signed-out session teaches nothing — sign in first."
        }
        return null
    }

    /* ---------------- one item ---------------- */

    private suspend fun watchYouTube(
        id: String,
        title: String,
        cfg: RunConfig,
        io: RunListener
    ): Int {
        if (!navigate(Platform.YOUTUBE.item(id))) {
            io.log(LogKind.WARN, "Could not open $id")
            return 0
        }
        if (!waitFor("!!document.querySelector('video')", 18_000)) {
            io.log(LogKind.WARN, "No player appeared for $id")
            return 0
        }

        val target = jitter(cfg.dwellSeconds)
        io.log(LogKind.STEP, "Watching ${title.ifBlank { id }.take(58)} — ${target}s")

        var watched = 0
        var adSeen = false
        while (watched < target && !stopping) {
            val tick = evalObject(Snips.WATCH_TICK) ?: break
            if (!tick.optBoolean("ok")) break
            if (tick.optBoolean("ad")) adSeen = true else watched += 2
            val t = tick.optDouble("t", 0.0)
            val dur = tick.optDouble("dur", 0.0)
            // A short video that has run out has given all the signal it has.
            if (!tick.optBoolean("ad") && dur > 0 && t >= dur - 1.2) break
            nap(2000)
        }
        if (adSeen) io.log(LogKind.INFO, "Sat through an ad — those seconds were not counted")

        if (cfg.like) {
            when (evalString(Snips.LIKE_YOUTUBE)) {
                "liked" -> io.log(LogKind.GOOD, "Liked it")
                "missing" -> io.log(LogKind.WARN, "Like button not found")
            }
        }
        if (cfg.follow && evalString(Snips.SUBSCRIBE_YOUTUBE) == "subscribed") {
            io.log(LogKind.GOOD, "Subscribed to the channel")
        }
        return watched
    }

    private suspend fun viewInstagram(
        permalink: String,
        cfg: RunConfig,
        io: RunListener
    ): Int {
        if (!navigate(Platform.INSTAGRAM.item(permalink))) {
            io.log(LogKind.WARN, "Could not open $permalink")
            return 0
        }
        nap(1600)
        evalJson(Snips.PLAY_INSTAGRAM)

        val target = jitter(cfg.dwellSeconds)
        io.log(LogKind.STEP, "Viewing $permalink — ${target}s")

        var watched = 0
        while (watched < target && !stopping) {
            nap(2000)
            watched += 2
            if (watched % 8 == 0) evalJson(Snips.PLAY_INSTAGRAM)
        }

        if (cfg.like && evalString(Snips.LIKE_INSTAGRAM) == "liked") {
            io.log(LogKind.GOOD, "Liked it")
        }
        if (cfg.follow && evalString(Snips.FOLLOW_INSTAGRAM) == "followed") {
            io.log(LogKind.GOOD, "Followed the account")
        }
        return watched
    }

    /*
     * YouTube hand-off.
     *
     * Google blocks sign-in from a WebView, so the session in this app can never
     * be the user's real YouTube account. What the WebView *can* do without any
     * sign-in is search — results render fine signed out. So Reseed harvests
     * here, and the watching happens in the user's own Chrome, where their
     * Google session already lives.
     *
     * Nothing about this pretends to be a watch. It returns a list; the caller
     * hands it to Chrome and says so.
     */
    suspend fun harvestQueue(cfg: RunConfig, io: RunListener): List<String> {
        stopping = false
        val collected = LinkedHashSet<String>()
        val tags = cfg.tags
        var step = 0

        for (tag in tags) {
            if (stopping) break
            step++
            io.progress(step.toFloat() / tags.size.coerceAtLeast(1))
            io.status("Searching #$tag")
            io.log(LogKind.STEP, "Searching #$tag")

            if (!navigate(Platform.YOUTUBE.search(tag))) {
                io.log(LogKind.WARN, "Could not open #$tag")
                continue
            }
            // Results are client-rendered and can take several seconds; waiting
            // for them beats a fixed sleep that harvests an empty page.
            val ready = waitFor(
                "document.querySelectorAll('a[href*=\"/watch?v=\"]').length > 2",
                18_000
            )
            if (!ready) io.log(LogKind.WARN, "Results were slow for #$tag")
            nap(900)

            val found = evalArray(Snips.HARVEST_YOUTUBE)
            val picks = mutableListOf<String>()
            for (i in 0 until (found?.length() ?: 0)) {
                val o = found!!.optJSONObject(i) ?: continue
                val id = o.optString("id")
                if (id.isNotEmpty()) picks += id
            }
            if (picks.isEmpty()) {
                io.log(LogKind.WARN, "Nothing came back for #$tag")
                continue
            }
            // Take from the top but not always the same few, so repeat runs on
            // the same tags do not queue an identical list.
            val chosen = picks.take(maxOf(cfg.itemsPerTag * 3, 8))
                .shuffled()
                .take(cfg.itemsPerTag)
            collected += chosen
            io.log(LogKind.GOOD, "Queued ${chosen.size} from #$tag")
        }

        io.progress(1f)
        // YouTube's temporary-playlist endpoint caps out; keep it comfortable.
        return collected.toList().shuffled().take(50)
    }

    /* ---------------- the run ---------------- */

    @SuppressLint("SetJavaScriptEnabled")
    suspend fun run(cfg: RunConfig, io: RunListener): RunResult {
        stopping = false
        val tally = Tally()

        val perRound = cfg.tags.size * (1 + cfg.itemsPerTag) + 1
        val totalSteps = (cfg.rounds * perRound).coerceAtLeast(1)
        var step = 0
        fun advance(text: String? = null) {
            step++
            io.progress(min(1f, step.toFloat() / totalSteps))
            text?.let { io.status(it) }
        }

        io.status("Checking the session")
        gateReason(cfg.platform)?.let {
            return RunResult(stopped = true, blockedReason = it, tally = tally)
        }

        io.log(
            LogKind.STEP,
            "Reseeding ${cfg.platform.label} with ${cfg.tags.size} tag" +
                (if (cfg.tags.size == 1) "" else "s") + " over ${cfg.rounds} round" +
                (if (cfg.rounds == 1) "" else "s")
        )

        for (round in 1..cfg.rounds) {
            if (stopping) break
            for (tag in cfg.tags.shuffled()) {
                if (stopping) break
                io.counter("round $round of ${cfg.rounds}")

                advance("Opening #$tag")
                io.log(LogKind.STEP, if (cfg.search) "Searching #$tag" else "Opening #$tag")
                if (!navigate(cfg.platform.search(tag))) {
                    io.log(LogKind.WARN, "Could not open #$tag")
                    continue
                }
                if (cfg.search) tally.searches++
                nap(2200)

                gateReason(cfg.platform)?.let {
                    return RunResult(stopped = true, blockedReason = it, tally = tally)
                }

                if (cfg.platform == Platform.INSTAGRAM) evalAsync(Snips.scroll(2))

                val picks = mutableListOf<Pair<String, String>>()
                if (cfg.platform == Platform.YOUTUBE) {
                    val found = evalArray(Snips.HARVEST_YOUTUBE)
                    for (i in 0 until (found?.length() ?: 0)) {
                        val o = found!!.optJSONObject(i) ?: continue
                        picks += o.optString("id") to o.optString("title")
                    }
                } else {
                    val found = evalArray(Snips.HARVEST_INSTAGRAM)
                    for (i in 0 until (found?.length() ?: 0)) {
                        picks += found!!.optString(i) to ""
                    }
                }

                if (picks.isEmpty()) {
                    io.log(LogKind.WARN, "Nothing came back for #$tag")
                    continue
                }

                // Draw from the top of the results, but not always the same few,
                // or the account rewatches one video every round.
                val pool = picks.take(maxOf(cfg.itemsPerTag * 3, 8)).shuffled()
                val chosen = pool.take(cfg.itemsPerTag)

                for ((index, pick) in chosen.withIndex()) {
                    if (stopping) break
                    advance("#$tag — item ${index + 1} of ${chosen.size}")
                    val seconds = if (cfg.platform == Platform.YOUTUBE) {
                        watchYouTube(pick.first, pick.second, cfg, io)
                    } else {
                        viewInstagram(pick.first, cfg, io)
                    }
                    if (seconds > 0) {
                        tally.items++
                        tally.seconds += seconds
                    }
                    nap(Random.nextLong(900, 2400))
                }
            }

            if (stopping) break
            advance("Letting the feed re-rank")
            io.log(LogKind.STEP, "Round $round done — reloading the feed")
            navigate(cfg.platform.home)
            nap(2500)
            evalAsync(Snips.scroll(2))
        }

        io.progress(1f)
        return RunResult(stopped = stopping, blockedReason = null, tally = tally)
    }
}
