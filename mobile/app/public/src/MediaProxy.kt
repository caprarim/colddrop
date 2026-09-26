package com.caprarim.colddrop

import android.content.Context
import android.util.LruCache
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FilterInputStream
import java.net.HttpURLConnection

object MediaProxy {
    private val route = Regex("^/pc/api/files/([a-f0-9-]{36})/(content|thumbnail)$")
    private val memory = object : LruCache<String, ByteArray>(24 * 1024 * 1024) { override fun sizeOf(key: String, value: ByteArray) = value.size }
    private val reasons = mapOf(200 to "OK", 206 to "Partial Content", 400 to "Bad Request", 401 to "Unauthorized", 404 to "Not Found", 405 to "Method Not Allowed", 409 to "Conflict", 416 to "Range Not Satisfiable", 502 to "Bad Gateway")

    fun handle(context: Context, connection: String, request: WebResourceRequest): WebResourceResponse {
        val match = route.matchEntire(request.url.path ?: "") ?: return failure(404)
        if (request.method != "GET") return failure(405)
        val (id, kind) = match.destructured
        return try {
            val pc = JSONObject(connection)
            Network.validate(pc.getString("base"), pc.getString("key"))
            if (kind == "thumbnail") thumbnail(context, pc, id) else content(pc, id, request.requestHeaders)
        } catch (_: Exception) { failure(502) }
    }

    private fun content(pc: JSONObject, id: String, headers: Map<String, String>): WebResourceResponse {
        val connection = Network.open(pc, "/api/files/$id/content")
        connection.readTimeout = 30000
        headers.entries.firstOrNull { it.key.equals("Range", true) }?.let { connection.setRequestProperty("Range", it.value) }
        val code = connection.responseCode
        if (code !in 200..299) { connection.disconnect(); return failure(code) }
        val mime = (connection.contentType ?: "application/octet-stream").substringBefore(';').trim()
        val reply = mutableMapOf("Accept-Ranges" to "bytes", "Cache-Control" to "no-store")
        connection.getHeaderField("Content-Length")?.let { reply["Content-Length"] = it }
        connection.getHeaderField("Content-Range")?.let { reply["Content-Range"] = it }
        val stream = object : FilterInputStream(connection.inputStream) { override fun close() { try { super.close() } finally { connection.disconnect() } } }
        return WebResourceResponse(mime, null, code, reasons[code] ?: "OK", reply, stream)
    }

    private fun thumbnail(context: Context, pc: JSONObject, id: String): WebResourceResponse {
        val base = pc.getString("base")
        val key = "$base|$id"
        memory.get(key)?.let { return image(it) }
        val folder = File(context.cacheDir, "thumbnails").apply { mkdirs() }
        val cached = File(folder, "${Integer.toHexString(base.hashCode())}-$id.jpg")
        if (cached.length() > 0) { try { val bytes = cached.readBytes(); memory.put(key, bytes); return image(bytes) } catch (_: Exception) {} }
        val connection: HttpURLConnection = Network.open(pc, "/api/files/$id/thumbnail")
        try {
            connection.readTimeout = 20000
            val code = connection.responseCode
            if (code != 200) return failure(code)
            val output = ByteArrayOutputStream()
            connection.inputStream.use { input -> val buffer = ByteArray(64 * 1024); while (true) { val n = input.read(buffer); if (n < 0) break; output.write(buffer, 0, n); if (output.size() > 4 * 1024 * 1024) return failure(502) } }
            val bytes = output.toByteArray()
            memory.put(key, bytes)
            try { val temp = File.createTempFile("thumb", ".tmp", folder); temp.writeBytes(bytes); if (!temp.renameTo(cached)) temp.delete() } catch (_: Exception) {}
            return image(bytes)
        } finally { connection.disconnect() }
    }

    fun trim(context: Context) {
        val files = File(context.cacheDir, "thumbnails").listFiles()?.sortedBy { it.lastModified() } ?: return
        var total = files.sumOf { it.length() }
        for (file in files) { if (total <= 48L * 1024 * 1024) break; total -= file.length(); file.delete() }
    }

    private fun image(bytes: ByteArray) = WebResourceResponse("image/jpeg", null, 200, "OK", mapOf("Cache-Control" to "private, max-age=86400", "Content-Length" to bytes.size.toString()), ByteArrayInputStream(bytes))

    private fun failure(code: Int): WebResourceResponse {
        val status = if (code in 400..599) code else 502
        return WebResourceResponse("text/plain", "utf-8", status, reasons[status] ?: "Error", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))
    }
}
