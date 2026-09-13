package com.caprarim.colddrop

import android.app.Activity
import android.os.Bundle
import android.os.Build
import android.content.*
import android.net.Uri
import android.webkit.*
import android.provider.OpenableColumns
import android.Manifest
import android.view.View
import android.view.WindowInsets
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import com.google.zxing.integration.android.IntentIntegrator
import org.json.JSONObject
import java.util.UUID

class MainActivity : Activity() {
    private lateinit var web: WebView
    private var pendingPair: String? = null
    private var pendingDownload: JSONObject? = null
    private var pageReady = false
    private val prefs by lazy { getSharedPreferences("colddrop", MODE_PRIVATE) }
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            intent?.getStringExtra("transfer")?.let { json -> runOnUiThread { if (pageReady) web.evaluateJavascript("window.onColdDropTransfer?.($json)", null) } }
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingDownload = savedInstanceState?.getString("download")?.let { JSONObject(it) }
        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web = WebView(this)
        web.setBackgroundColor(android.graphics.Color.WHITE)
        web.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true
            allowFileAccess = false; allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(false)
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        web.addJavascriptInterface(Bridge(), "ColdDrop")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = request.url.host != "appassets.androidplatform.net"
            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                pendingPair?.let { value -> web.postDelayed({ web.evaluateJavascript("window.onColdDropScan?.(${JSONObject.quote(value)})", null) }, 500); pendingPair = null }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            private var custom: View? = null
            override fun onShowCustomView(view: View, callback: CustomViewCallback) { custom = view; setContentView(view) }
            override fun onHideCustomView() { custom = null; setContentView(web) }
        }
        setContentView(web)
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            web.setOnApplyWindowInsetsListener { view, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom); insets
            }
        }
        ContextCompat.registerReceiver(this, receiver, IntentFilter(TransferStore.ACTION), ContextCompat.RECEIVER_NOT_EXPORTED)
        pendingPair = intent?.dataString?.takeIf { it.startsWith("colddrop://pair") }
        web.loadUrl("https://appassets.androidplatform.net/assets/index.html")
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 99)
        TransferStore.recover(this)
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); intent.dataString?.let { if (pageReady) web.evaluateJavascript("window.onColdDropScan?.(${JSONObject.quote(it)})", null) else pendingPair = it } }
    override fun onResume() { super.onResume(); if (::web.isInitialized) web.evaluateJavascript("window.onColdDropResume?.()", null) }
    override fun onSaveInstanceState(outState: Bundle) { pendingDownload?.let { outState.putString("download", it.toString()) }; super.onSaveInstanceState(outState) }
    override fun onDestroy() { unregisterReceiver(receiver); web.removeJavascriptInterface("ColdDrop"); web.destroy(); super.onDestroy() }
    @Deprecated("Android legacy back dispatch")
    override fun onBackPressed() { web.evaluateJavascript("(function(){const d=document.querySelector('dialog[open]');if(d){d.dispatchEvent(new Event('cancel',{cancelable:true}));return true;}return false;})()") { consumed -> if (consumed != "true") moveTaskToBack(true) } }
    private fun error(message: String) { runOnUiThread { web.evaluateJavascript("window.onColdDropError?.(${JSONObject.quote(message)})", null) } }
    private fun startTransfers() { try { ContextCompat.startForegroundService(this, Intent(this, TransferService::class.java)) } catch (e: Exception) { error(e.message ?: "Open ColdDrop to start the transfer") } }

    inner class Bridge {
        @JavascriptInterface fun connection(): String = prefs.getString("connection", "") ?: ""
        @JavascriptInterface fun transfers(): String = TransferStore.all(this@MainActivity).toString()
        @JavascriptInterface fun saveConnection(value: String) {
            try { val c = JSONObject(value); Network.validate(c.getString("base"), c.getString("key")); prefs.edit().putString("connection", c.toString()).apply() } catch (e: Exception) { error(e.message ?: "Invalid pairing link") }
        }
        @JavascriptInterface fun disconnect() { prefs.edit().remove("connection").apply() }
        @JavascriptInterface fun pickFiles() { runOnUiThread { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply { type = "*/*"; addCategory(Intent.CATEGORY_OPENABLE); putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) }, 41) } }
        @JavascriptInterface fun scan() { runOnUiThread { IntentIntegrator(this@MainActivity).setDesiredBarcodeFormats(IntentIntegrator.QR_CODE).setPrompt("Scan the QR code in ColdDrop on your PC").setBeepEnabled(false).setOrientationLocked(false).initiateScan() } }
        @JavascriptInterface fun download(id: String, name: String, mime: String) {
            runOnUiThread {
                try {
                    require(Regex("[a-f0-9-]{36}").matches(id))
                    val c = JSONObject(connection()); Network.validate(c.getString("base"), c.getString("key"))
                    pendingDownload = JSONObject().put("id", UUID.randomUUID().toString()).put("fileId", id).put("name", name).put("mime", mime).put("base", c.getString("base")).put("key", c.getString("key")).put("direction", "download")
                    startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply { type = mime; addCategory(Intent.CATEGORY_OPENABLE); putExtra(Intent.EXTRA_TITLE, name); addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) }, 42)
                } catch (e: Exception) { error(e.message ?: "Pair with your PC first") }
            }
        }
        @JavascriptInterface fun retry(id: String) { runOnUiThread { TransferStore.retry(this@MainActivity, id); startTransfers() } }
    }
    @Deprecated("File and QR activity results")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val scan = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (scan != null) { scan.contents?.let { web.evaluateJavascript("window.onColdDropScan?.(${JSONObject.quote(it)})", null) }; return }
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK || data == null) { if (requestCode == 42) pendingDownload = null; return }
        if (requestCode == 41) {
            try {
                val c = JSONObject(prefs.getString("connection", "") ?: ""); Network.validate(c.getString("base"), c.getString("key"))
                val uris = mutableListOf<Uri>(); data.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) } ?: data.data?.let { uris.add(it) }
                for (uri in uris) {
                    try { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
                    var name = "File"; var size = -1L
                    contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor -> if (cursor.moveToFirst()) { name = cursor.getString(0) ?: "File"; if (!cursor.isNull(1)) size = cursor.getLong(1) } }
                    if (size < 0) { error("$name has no known size. Save it to phone storage first, then add it."); continue }
                    val job = JSONObject().put("id", UUID.randomUUID().toString()).put("name", name).put("size", size).put("sent", 0).put("uri", uri.toString()).put("mime", contentResolver.getType(uri) ?: "application/octet-stream").put("base", c.getString("base")).put("key", c.getString("key")).put("direction", "upload").put("status", "queued")
                    TransferStore.put(this, job)
                }
                startTransfers()
            } catch (e: Exception) { error(e.message ?: "Could not add these files") }
        } else if (requestCode == 42) {
            val job = pendingDownload; pendingDownload = null
            val uri = data.data ?: return
            if (job != null) {
                try { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
                job.put("uri", uri.toString()).put("status", "queued").put("sent", 0).put("size", 0)
                TransferStore.put(this, job); startTransfers()
            }
        }
    }
}
