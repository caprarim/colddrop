package com.caprarim.colddrop

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.*
import android.net.Uri
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.media.MediaMetadataRetriever
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.*
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class TransferService : Service() {
    companion object { @Volatile var running = false; private const val CHANNEL = "transfers"; private const val NOTIFICATION = 71; private const val CHUNK = 4 * 1024 * 1024 }
    private val executor = Executors.newSingleThreadExecutor()
    private val cancelled = AtomicBoolean(false)
    private var wake: PowerManager.WakeLock? = null
    @Volatile private var current: JSONObject? = null
    private var lastNotice = 0L
    override fun onBind(intent: Intent?) = null
    override fun onCreate() {
        super.onCreate(); running = true
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "File transfers", NotificationManager.IMPORTANCE_LOW))
        startForeground(NOTIFICATION, notification("Preparing files", 0, 0), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ColdDrop:Transfers").apply { acquire(6 * 60 * 60 * 1000L) }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        executor.execute {
            try {
                while (!cancelled.get()) {
                    val job = TransferStore.queued(this) ?: break
                    current = job
                    try {
                        if (job.optString("direction") == "download") download(job) else upload(job)
                        ensureActive()
                        job.put("status", "complete").put("sent", job.optLong("size")).remove("error")
                        TransferStore.put(this, job)
                    } catch (e: Exception) {
                        job.put("status", "failed").put("error", if (cancelled.get()) "Transfer paused by Android. Open the app and retry." else e.message ?: "Transfer interrupted. Reconnect to your PC and retry.")
                        TransferStore.put(this, job)
                    } finally { current = null }
                }
            } finally { stopSelfResult(startId) }
        }
        return START_NOT_STICKY
    }
    private fun ensureActive() { if (cancelled.get() || Thread.currentThread().isInterrupted) throw InterruptedIOException("Transfer interrupted") }
    private fun notification(name: String, sent: Long, size: Long): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_transfer).setContentTitle("ColdDrop").setContentText(name).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setProgress(100, if (size > 0) (sent * 100 / size).toInt().coerceIn(0, 100) else 0, size <= 0).build()
    }
    private fun progress(job: JSONObject, sent: Long, force: Boolean = false) {
        job.put("sent", sent)
        val time = SystemClock.elapsedRealtime()
        if (force || time - lastNotice > 400) {
            lastNotice = time; TransferStore.put(this, job)
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification(job.getString("name"), sent, job.optLong("size")))
        }
    }
    private fun source(job: JSONObject, offset: Long): InputStream {
        val stream = contentResolver.openInputStream(Uri.parse(job.getString("uri"))) ?: throw IOException("This file is no longer available. Add it again.")
        try {
            if (offset > 0) {
                var seeked = false
                if (stream is FileInputStream) { try { stream.channel.position(stream.channel.position() + offset); seeked = true } catch (_: IOException) {} }
                if (!seeked) {
                    var remaining = offset; val buffer = ByteArray(256 * 1024)
                    while (remaining > 0) { ensureActive(); val skipped = stream.skip(remaining); if (skipped > 0) remaining -= skipped else { val read = stream.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt()); if (read < 0) throw EOFException("The original file changed. Add it again."); remaining -= read } }
                }
            }
            return stream
        } catch (e: Exception) { stream.close(); throw e }
    }
    private fun upload(job: JSONObject) {
        job.put("status", "uploading"); TransferStore.put(this, job)
        var id = job.optString("uploadId")
        if (id.isEmpty()) {
            val payload = JSONObject().put("name", job.getString("name")).put("size", job.getLong("size")).put("source", "Phone").toString().toByteArray(Charsets.UTF_8)
            id = Network.request(job, "/api/uploads", "POST", payload).getString("id")
            job.put("uploadId", id); TransferStore.put(this, job)
        }
        val state = Network.request(job, "/api/uploads/$id")
        if (state.optBoolean("ready")) return
        var offset = state.getLong("offset"); val size = job.getLong("size")
        require(offset <= size) { "Upload size changed. Add the file again." }
        var stream: InputStream? = null
        try {
            stream = source(job, offset)
            val buffer = ByteArray(CHUNK); var failures = 0
            progress(job, offset, true)
            while (offset < size) {
                ensureActive()
                val need = minOf(CHUNK.toLong(), size - offset).toInt(); var count = 0
                while (count < need) { val n = stream!!.read(buffer, count, need - count); if (n < 0) throw EOFException("The original file changed or could not be read."); count += n }
                try {
                    val response = Network.request(job, "/api/uploads/$id?offset=$offset", "PUT", buffer, count, "application/octet-stream")
                    offset = response.getLong("offset"); failures = 0; progress(job, offset)
                } catch (e: Exception) {
                    ensureActive(); if (++failures >= 5) throw e
                    stream?.close(); stream = null
                    Thread.sleep(1000L * failures)
                    offset = Network.request(job, "/api/uploads/$id").getLong("offset")
                    stream = source(job, offset)
                }
            }
        } finally { stream?.close() }
        ensureActive()
        try { thumbnail(job)?.let { Network.request(job, "/api/files/$id/thumbnail", "PUT", it, it.size, "image/jpeg") } } catch (_: Exception) { /* Thumbnail failure must not discard the original file. */ }
        ensureActive()
        Network.request(job, "/api/uploads/$id/complete", "POST")
        progress(job, size, true)
    }
    private fun thumbnail(job: JSONObject): ByteArray? {
        val mime = job.optString("mime"); val uri = Uri.parse(job.getString("uri"))
        var bitmap: Bitmap? = null
        try {
            if (mime.startsWith("video/")) {
                val retriever = MediaMetadataRetriever()
                try { retriever.setDataSource(this, uri); bitmap = retriever.getScaledFrameAtTime(100000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 480, 480) } finally { retriever.release() }
            } else if (mime.startsWith("image/")) {
                bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(contentResolver, uri)) { decoder, info, _ ->
                    decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                    val scale = minOf(480f / info.size.width, 480f / info.size.height, 1f)
                    decoder.setTargetSize(maxOf(1, (info.size.width * scale).toInt()), maxOf(1, (info.size.height * scale).toInt()))
                }
            }
            val image = bitmap ?: return null
            val output = ByteArrayOutputStream(); image.compress(Bitmap.CompressFormat.JPEG, 80, output); return output.toByteArray()
        } finally { bitmap?.recycle() }
    }
    private fun download(job: JSONObject) {
        job.put("status", "downloading"); TransferStore.put(this, job)
        val id = job.getString("fileId"); require(Regex("[a-f0-9-]{36}").matches(id))
        val connection = Network.open(job, "/api/files/$id/content?download=true")
        try {
            val code = connection.responseCode
            if (code != 200) throw IOException(connection.errorStream?.bufferedReader()?.use { it.readText().take(240) } ?: "PC returned $code")
            val size = connection.getHeaderFieldLong("Content-Length", -1)
            if (size < 0) throw IOException("PC did not provide a file size")
            job.put("size", size); progress(job, 0, true)
            connection.inputStream.buffered(256 * 1024).use { input ->
                val dest = contentResolver.openOutputStream(Uri.parse(job.getString("uri")), "wt") ?: throw IOException("The selected save location is unavailable")
                dest.buffered(256 * 1024).use { output ->
                    val buffer = ByteArray(256 * 1024); var saved = 0L
                    while (true) { ensureActive(); val n = input.read(buffer); if (n < 0) break; output.write(buffer, 0, n); saved += n; progress(job, saved) }
                    output.flush(); if (saved != size) throw IOException("Download interrupted. Tap Retry to download again.")
                    progress(job, saved, true)
                }
            }
        } finally { connection.disconnect() }
    }
    override fun onTimeout(startId: Int, fgsType: Int) {
        cancelled.set(true)
        current?.let { it.put("status", "failed").put("error", "Android paused this long transfer. Open ColdDrop and retry."); TransferStore.put(this, it) }
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); executor.shutdownNow()
    }
    override fun onDestroy() { cancelled.set(true); running = false; executor.shutdownNow(); wake?.let { if (it.isHeld) it.release() }; stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy() }
}
