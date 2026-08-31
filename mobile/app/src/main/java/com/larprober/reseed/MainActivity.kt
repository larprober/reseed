package com.larprober.reseed

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import androidx.core.widget.ImageViewCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.chip.Chip
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.larprober.reseed.databinding.ActivityMainBinding
import com.larprober.reseed.databinding.PartSliderBinding
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity(), RunListener {

    private lateinit var binding: ActivityMainBinding
    private lateinit var engine: Engine
    private lateinit var prefs: android.content.SharedPreferences

    private var platform = Platform.YOUTUBE
    private val tags = mutableMapOf(
        Platform.YOUTUBE to mutableListOf<String>(),
        Platform.INSTAGRAM to mutableListOf<String>()
    )

    private var runJob: Job? = null
    private val logLines = SpannableStringBuilder()
    private val clock = SimpleDateFormat("HH:mm:ss", Locale.US)

    /**
     * A phone Chrome string with no "; wv" token. Google refuses sign-in to
     * anything that identifies itself as a WebView, and the default string on
     * Android says exactly that.
     */
    private val chromeUa =
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/131.0.0.0 Mobile Safari/537.36"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        prefs = getSharedPreferences("reseed", Context.MODE_PRIVATE)

        setUpWebView()
        setUpSliders()
        setUpSignals()
        setUpChips()
        setUpButtons()

        restore()
        applyPlatform(platform, initial = true)
        refresh()
        binding.web.loadUrl(platform.home)

        appendLog(LogKind.INFO, "Reseed ready.")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val sheet = BottomSheetBehavior.from(binding.sheet)
                when {
                    sheet.state == BottomSheetBehavior.STATE_EXPANDED ->
                        sheet.state = BottomSheetBehavior.STATE_COLLAPSED
                    binding.web.canGoBack() -> binding.web.goBack()
                    else -> finish()
                }
            }
        })
    }

    /* ---------------- setup ---------------- */

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWebView() {
        with(binding.web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // Without this nothing plays until a tap, which defeats the whole run.
            mediaPlaybackRequiresUserGesture = false
            userAgentString = chromeUa
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(binding.web, true)

        binding.web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                binding.pageProgress.progress = newProgress
                binding.pageProgress.visibility =
                    if (newProgress in 1..99) android.view.View.VISIBLE
                    else android.view.View.GONE
            }
        }

        engine = Engine(binding.web)
        engine.attach()
    }

    private fun configureSlider(
        row: PartSliderBinding,
        label: String,
        from: Int,
        to: Int,
        value: Int
    ) {
        row.sliderLabel.text = label
        with(row.slider) {
            // Widen the top bound before moving the value, or the Material
            // slider rejects a value that sits outside the old range.
            valueTo = maxOf(to.toFloat(), this.value)
            this.value = value.toFloat().coerceIn(valueFrom, valueTo)
            valueFrom = from.toFloat()
            valueTo = to.toFloat()
            stepSize = 1f
            addOnChangeListener { _, _, _ -> refresh() }
        }
    }

    private fun setUpSliders() {
        configureSlider(binding.rowDwell, getString(R.string.dwell_label), 8, 150, 35)
        configureSlider(binding.rowPerTag, getString(R.string.per_tag_label), 1, 10, 3)
        configureSlider(binding.rowRounds, getString(R.string.rounds_label), 1, 20, 3)
    }

    private fun setUpSignals() {
        fun tint(view: android.widget.ImageView, on: Boolean) {
            ImageViewCompat.setImageTintList(
                view,
                android.content.res.ColorStateList.valueOf(
                    ContextCompat.getColor(this, if (on) R.color.accent else R.color.text_faint)
                )
            )
        }

        binding.rowSearch.signalIcon.setImageResource(R.drawable.ic_search)
        binding.rowSearch.signalTitle.setText(R.string.signal_search)
        binding.rowSearch.signalNote.setText(R.string.signal_search_note)
        binding.rowSearch.signalSwitch.isChecked = true

        binding.rowLike.signalIcon.setImageResource(R.drawable.ic_heart)
        binding.rowLike.signalTitle.setText(R.string.signal_like)

        binding.rowFollow.signalIcon.setImageResource(R.drawable.ic_bell)
        binding.rowFollow.signalNote.setText(R.string.signal_follow_note)

        for (row in listOf(binding.rowSearch, binding.rowLike, binding.rowFollow)) {
            tint(row.signalIcon, row.signalSwitch.isChecked)
            row.signalSwitch.setOnCheckedChangeListener { _, checked ->
                tint(row.signalIcon, checked)
                refresh()
            }
            row.root.setOnClickListener { row.signalSwitch.toggle() }
        }
    }

    private fun setUpChips() {
        binding.tagInput.setOnEditorActionListener { view, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                addTags(view.text.toString())
                view.text = ""
                true
            } else {
                false
            }
        }
    }

    private fun setUpButtons() {
        binding.platformGroup.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (!isChecked || runJob != null) return@addOnButtonCheckedListener
            applyPlatform(
                if (checkedId == R.id.btnInstagram) Platform.INSTAGRAM else Platform.YOUTUBE,
                initial = false
            )
        }

        binding.btnRun.setOnClickListener { confirmThenRun() }

        binding.btnStop.setOnClickListener {
            engine.stop()
            binding.status.text = getString(R.string.stop) + " — finishing this item"
            appendLog(LogKind.WARN, "Stop requested. Finishing the current item.")
        }

        binding.btnHistory.setOnClickListener {
            // In hand-off mode the history that matters belongs to the browser
            // holding the account, not to this WebView.
            if (platform.mode == Mode.HANDOFF) {
                openCustomTab(platform.history)
            } else {
                binding.web.loadUrl(platform.history)
                BottomSheetBehavior.from(binding.sheet).state = BottomSheetBehavior.STATE_COLLAPSED
            }
            appendLog(LogKind.INFO, "Opened the history controls. Nothing is deleted unless you tap it.")
        }

        binding.btnSignOut.setOnClickListener { confirmSignOut() }

        binding.veilDismiss.setOnClickListener {
            binding.veil.visibility = android.view.View.GONE
        }
    }

    /* ---------------- state ---------------- */

    private var applyingPlatform = false

    /** Opens a URL in the user's real browser, where their Google session lives. */
    private fun openCustomTab(url: String) {
        val intent = CustomTabsIntent.Builder()
            .setShowTitle(true)
            .setDefaultColorSchemeParams(
                CustomTabColorSchemeParams.Builder()
                    .setToolbarColor(ContextCompat.getColor(this, R.color.ink))
                    .build()
            )
            .build()
        try {
            intent.launchUrl(this, Uri.parse(url))
        } catch (e: Exception) {
            appendLog(LogKind.BAD, "No browser could open that link.")
        }
    }

    private fun applyPlatform(next: Platform, initial: Boolean) {
        // check() fires the group's listener, which calls back in here.
        if (applyingPlatform) return
        applyingPlatform = true
        platform = next
        binding.platformGroup.check(
            if (next == Platform.INSTAGRAM) R.id.btnInstagram else R.id.btnYouTube
        )
        applyingPlatform = false

        binding.tagsHint.setText(
            if (next == Platform.YOUTUBE) R.string.tags_hint_youtube
            else R.string.tags_hint_instagram
        )
        binding.historyNote.setText(
            if (next == Platform.YOUTUBE) R.string.history_note_youtube
            else R.string.history_note_instagram
        )
        binding.rowFollow.signalTitle.setText(
            if (next == Platform.YOUTUBE) R.string.signal_follow_youtube
            else R.string.signal_follow_instagram
        )
        binding.rowLike.signalNote.text =
            if (next == Platform.YOUTUBE) "A public action on someone else's video"
            else "A public action on someone else's post"

        // In hand-off mode the WebView is only a scraper: its session is not the
        // account being trained, so dwell, rounds and every act-on-the-account
        // switch would be lying about what happens. They come off the screen.
        val handoff = next.mode == Mode.HANDOFF
        val hide = if (handoff) android.view.View.GONE else android.view.View.VISIBLE
        binding.rowDwell.root.visibility = hide
        binding.dwellHint.visibility = hide
        binding.rowRounds.root.visibility = hide
        binding.signalsHeader.visibility = hide
        binding.watchCard.visibility = hide
        binding.rowSearch.root.visibility = hide
        binding.rowLike.root.visibility = hide
        binding.rowFollow.root.visibility = hide
        binding.handoffNote.visibility = if (handoff) android.view.View.VISIBLE else android.view.View.GONE
        binding.handoffNote.text = getString(R.string.handoff_note)
        binding.btnRun.text = getString(if (handoff) R.string.run_handoff else R.string.run)
        if (runJob == null) {
            binding.status.setText(
                if (handoff) R.string.idle_status_handoff else R.string.idle_status
            )
        }

        renderChips()
        refresh()
        if (!initial) binding.web.loadUrl(next.home)
    }

    private fun renderChips() {
        binding.tagChips.removeAllViews()
        for (tag in tags.getValue(platform)) {
            val chip = Chip(this).apply {
                text = "#$tag"
                isCloseIconVisible = true
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text))
                chipBackgroundColor = android.content.res.ColorStateList.valueOf(
                    ContextCompat.getColor(this@MainActivity, R.color.surface2)
                )
                chipStrokeWidth = 1f
                chipStrokeColor = android.content.res.ColorStateList.valueOf(
                    ContextCompat.getColor(this@MainActivity, R.color.line)
                )
                closeIconTint = android.content.res.ColorStateList.valueOf(
                    ContextCompat.getColor(this@MainActivity, R.color.text_faint)
                )
                setOnCloseIconClickListener {
                    tags.getValue(platform).remove(tag)
                    renderChips()
                    refresh()
                }
            }
            binding.tagChips.addView(chip)
        }
    }

    private fun addTags(raw: String) {
        val list = tags.getValue(platform)
        for (piece in raw.split(',', '\n')) {
            val tag = piece.trim().trimStart('#').replace(Regex("\\s+"), "")
            if (tag.isNotEmpty() && tag !in list && list.size < 40) list.add(tag)
        }
        renderChips()
        refresh()
    }

    private fun currentConfig() = RunConfig(
        platform = platform,
        tags = tags.getValue(platform).toList(),
        dwellSeconds = binding.rowDwell.slider.value.roundToInt(),
        itemsPerTag = binding.rowPerTag.slider.value.roundToInt(),
        rounds = binding.rowRounds.slider.value.roundToInt(),
        search = binding.rowSearch.signalSwitch.isChecked,
        like = binding.rowLike.signalSwitch.isChecked,
        follow = binding.rowFollow.signalSwitch.isChecked
    )

    private fun formatDuration(seconds: Int): String = when {
        seconds < 90 -> "${seconds}s"
        seconds < 3600 -> "${(seconds / 60.0).roundToInt()} min"
        else -> "${seconds / 3600}h ${(seconds % 3600) / 60}m"
    }

    private fun refresh() {
        val cfg = currentConfig()

        binding.rowDwell.sliderValue.text = "${cfg.dwellSeconds}s"
        binding.rowPerTag.sliderValue.text = "${cfg.itemsPerTag}"
        binding.rowRounds.sliderValue.text = "${cfg.rounds}"

        binding.dwellHint.text = if (cfg.platform == Platform.YOUTUBE) {
            if (cfg.dwellSeconds < 30) "Under 30s barely registers as a watch. It still counts, just faintly."
            else "Long enough to count as a real watch."
        } else {
            if (cfg.dwellSeconds < 20) "Short views are weak signal on Instagram too."
            else "A solid dwell for a post or reel."
        }

        binding.estimate.text = when {
            cfg.tags.isEmpty() -> "Add a tag to see what a run would cost."

            cfg.platform.mode == Mode.HANDOFF -> {
                val queued = minOf(cfg.tags.size * cfg.itemsPerTag, 50)
                "Queues about $queued video${if (queued == 1) "" else "s"} from " +
                    "${cfg.tags.size} tag${if (cfg.tags.size == 1) "" else "s"}, then opens " +
                    "them in Chrome as one playlist. Searching takes a minute or so."
            }

            else -> {
                val items = cfg.rounds * cfg.tags.size * cfg.itemsPerTag
                val seconds = cfg.rounds *
                    (cfg.tags.size * (cfg.itemsPerTag * (cfg.dwellSeconds + 9) + 7) + 9)
                "This run opens $items item${if (items == 1) "" else "s"} across " +
                    "${cfg.tags.size} tag${if (cfg.tags.size == 1) "" else "s"}, " +
                    "and takes roughly ${formatDuration(seconds)}."
            }
        }

        binding.btnRun.isEnabled = runJob == null && cfg.tags.isNotEmpty()
        save()
    }

    private fun save() {
        val payload = JSONObject().apply {
            put("platform", platform.name)
            put("youtube", JSONArray(tags.getValue(Platform.YOUTUBE)))
            put("instagram", JSONArray(tags.getValue(Platform.INSTAGRAM)))
            put("dwell", binding.rowDwell.slider.value.roundToInt())
            put("perTag", binding.rowPerTag.slider.value.roundToInt())
            put("rounds", binding.rowRounds.slider.value.roundToInt())
            put("search", binding.rowSearch.signalSwitch.isChecked)
            put("like", binding.rowLike.signalSwitch.isChecked)
            put("follow", binding.rowFollow.signalSwitch.isChecked)
        }
        prefs.edit().putString("config", payload.toString()).apply()
    }

    private fun restore() {
        val stored = prefs.getString("config", null) ?: return
        val json = try {
            JSONObject(stored)
        } catch (e: Exception) {
            return
        }
        platform = runCatching { Platform.valueOf(json.optString("platform")) }
            .getOrDefault(Platform.YOUTUBE)
        for ((key, which) in listOf("youtube" to Platform.YOUTUBE, "instagram" to Platform.INSTAGRAM)) {
            val arr = json.optJSONArray(key) ?: continue
            val list = tags.getValue(which)
            list.clear()
            for (i in 0 until arr.length()) list.add(arr.optString(i))
        }
        binding.rowDwell.slider.value = json.optInt("dwell", 35).toFloat()
            .coerceIn(binding.rowDwell.slider.valueFrom, binding.rowDwell.slider.valueTo)
        binding.rowPerTag.slider.value = json.optInt("perTag", 3).toFloat()
            .coerceIn(binding.rowPerTag.slider.valueFrom, binding.rowPerTag.slider.valueTo)
        binding.rowRounds.slider.value = json.optInt("rounds", 3).toFloat()
            .coerceIn(binding.rowRounds.slider.valueFrom, binding.rowRounds.slider.valueTo)
        binding.rowSearch.signalSwitch.isChecked = json.optBoolean("search", true)
        binding.rowLike.signalSwitch.isChecked = json.optBoolean("like", false)
        binding.rowFollow.signalSwitch.isChecked = json.optBoolean("follow", false)
    }

    /* ---------------- running ---------------- */

    private fun confirmThenRun() {
        val cfg = currentConfig()
        if (cfg.tags.isEmpty() || runJob != null) return

        if (cfg.platform.mode == Mode.HANDOFF) {
            startHandoff(cfg)
            return
        }

        val public = buildList {
            if (cfg.like) add("like the posts it opens")
            if (cfg.follow) add(
                if (cfg.platform == Platform.YOUTUBE) "subscribe to the channels it lands on"
                else "follow the accounts it lands on"
            )
        }

        if (public.isEmpty()) {
            startRun(cfg)
            return
        }

        MaterialAlertDialogBuilder(this)
            .setTitle("This run acts on your account")
            .setMessage(
                "It will " + public.joinToString(", and ") + ".\n\n" +
                    "Those are real, visible actions on your ${cfg.platform.label} account " +
                    "and other people can see them. Watching alone stays private."
            )
            .setPositiveButton("Run it") { _, _ -> startRun(cfg) }
            .setNegativeButton("Cancel") { _, _ ->
                appendLog(LogKind.INFO, "Cancelled at the confirmation.")
            }
            .show()
    }

    /**
     * Harvest here, watch there. Reseed collects video ids in the WebView, which
     * needs no sign-in, then hands them to Chrome as one autoplaying playlist.
     * It never claims the watch — that happens in a browser it does not control.
     */
    private fun startHandoff(cfg: RunConfig) {
        BottomSheetBehavior.from(binding.sheet).state = BottomSheetBehavior.STATE_COLLAPSED
        binding.veil.visibility = android.view.View.GONE
        binding.btnRun.visibility = android.view.View.GONE
        binding.btnStop.visibility = android.view.View.VISIBLE
        setControlsEnabled(false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        runJob = lifecycleScope.launch {
            val ids = try {
                engine.harvestQueue(cfg, this@MainActivity)
            } catch (e: Throwable) {
                appendLog(LogKind.BAD, "Harvest failed: ${e.message ?: e.toString()}")
                emptyList()
            }

            runJob = null
            binding.btnRun.visibility = android.view.View.VISIBLE
            binding.btnStop.visibility = android.view.View.GONE
            setControlsEnabled(true)
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            refresh()

            if (ids.isEmpty()) {
                status("Nothing to queue")
                appendLog(LogKind.WARN, "No videos came back. Try different tags.")
                return@launch
            }

            status("${ids.size} videos ready")
            appendLog(LogKind.GOOD, "Queued ${ids.size} videos. Opening Chrome.")
            appendLog(
                LogKind.INFO,
                "Press play there. Watch time on your real account is what retrains the feed."
            )
            openCustomTab(Platform.queueUrl(ids))
        }
    }

    private fun startRun(cfg: RunConfig) {
        appendLog(LogKind.INFO, getString(R.string.keep_open))
        BottomSheetBehavior.from(binding.sheet).state = BottomSheetBehavior.STATE_COLLAPSED
        binding.veil.visibility = android.view.View.GONE
        binding.btnRun.visibility = android.view.View.GONE
        binding.btnStop.visibility = android.view.View.VISIBLE
        binding.counter.visibility = android.view.View.VISIBLE
        setControlsEnabled(false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        runJob = lifecycleScope.launch {
            val result = try {
                engine.run(cfg, this@MainActivity)
            } catch (e: Throwable) {
                appendLog(LogKind.BAD, "The run hit an error: ${e.message ?: e.toString()}")
                RunResult(stopped = true, blockedReason = null, tally = Tally())
            }

            runJob = null
            binding.btnRun.visibility = android.view.View.VISIBLE
            binding.btnStop.visibility = android.view.View.GONE
            binding.counter.visibility = android.view.View.GONE
            setControlsEnabled(true)
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            refresh()

            val reason = result.blockedReason
            if (reason != null) {
                status("Stopped")
                progress(0f)
                appendLog(LogKind.BAD, reason)
                binding.veilText.text = reason
                binding.veil.visibility = android.view.View.VISIBLE
                return@launch
            }

            val t = result.tally
            val summary = "${t.items} item${if (t.items == 1) "" else "s"} watched, " +
                "${formatDuration(t.seconds)} of dwell, ${t.searches} searches"
            if (result.stopped) {
                status("Stopped early")
                appendLog(LogKind.WARN, "Stopped by you — $summary")
            } else {
                status("Done")
                appendLog(LogKind.GOOD, "Run complete — $summary")
                appendLog(
                    LogKind.INFO,
                    "Give the feed a few hours and another round or two. It drifts, it does not flip."
                )
            }
        }
    }

    private fun setControlsEnabled(enabled: Boolean) {
        binding.platformGroup.isEnabled = enabled
        binding.btnYouTube.isEnabled = enabled
        binding.btnInstagram.isEnabled = enabled
        binding.tagInput.isEnabled = enabled
        binding.rowDwell.slider.isEnabled = enabled
        binding.rowPerTag.slider.isEnabled = enabled
        binding.rowRounds.slider.isEnabled = enabled
        binding.rowSearch.signalSwitch.isEnabled = enabled
        binding.rowLike.signalSwitch.isEnabled = enabled
        binding.rowFollow.signalSwitch.isEnabled = enabled
    }

    private fun confirmSignOut() {
        MaterialAlertDialogBuilder(this)
            .setTitle("Sign out")
            .setMessage(
                "This clears the cookies and site data Reseed keeps for both panes. " +
                    "Your accounts themselves are untouched."
            )
            .setPositiveButton("Clear it") { _, _ ->
                CookieManager.getInstance().removeAllCookies(null)
                CookieManager.getInstance().flush()
                binding.web.clearCache(true)
                binding.web.clearHistory()
                android.webkit.WebStorage.getInstance().deleteAllData()
                binding.web.loadUrl(platform.home)
                appendLog(LogKind.INFO, "Cleared the stored session.")
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /* ---------------- RunListener ---------------- */

    override fun log(kind: LogKind, message: String) = appendLog(kind, message)

    override fun status(text: String) {
        binding.status.text = text
    }

    override fun counter(text: String) {
        binding.counter.text = text
    }

    override fun progress(fraction: Float) {
        binding.runProgress.setProgressCompat((fraction * 100).roundToInt(), true)
    }

    private fun appendLog(kind: LogKind, message: String) {
        val colour = when (kind) {
            LogKind.STEP -> R.color.text
            LogKind.GOOD -> R.color.accent
            LogKind.WARN -> R.color.warn
            LogKind.BAD -> R.color.danger
            LogKind.INFO -> R.color.text_dim
        }
        val start = logLines.length
        logLines.append(clock.format(Date())).append("  ").append(message).append("\n")
        logLines.setSpan(
            ForegroundColorSpan(ContextCompat.getColor(this, colour)),
            start + 10, logLines.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
        )
        logLines.setSpan(
            ForegroundColorSpan(Color.parseColor("#4A5468")),
            start, start + 8, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
        )
        // Keep the tail; an unbounded log makes the sheet impossible to scroll.
        while (logLines.count { it == '\n' } > 160) {
            logLines.delete(0, logLines.indexOf("\n") + 1)
        }
        binding.log.text = logLines
    }

    /* ---------------- lifecycle ---------------- */

    override fun onPause() {
        super.onPause()
        // Android throttles a backgrounded WebView, so a run that keeps going
        // there would report watch time it never actually accrued.
        // A driven run must stop: Android throttles a backgrounded WebView and a
        // run that kept going would report watch time it never accrued. A hand-off
        // is different — leaving for Chrome is the whole point.
        if (runJob != null && platform.mode == Mode.DRIVE) {
            engine.stop()
            appendLog(LogKind.WARN, "Left the app — the run was stopped so it cannot over-report.")
        }
        binding.web.onPause()
    }

    override fun onResume() {
        super.onResume()
        binding.web.onResume()
    }

    override fun onDestroy() {
        engine.stop()
        binding.web.destroy()
        super.onDestroy()
    }
}
