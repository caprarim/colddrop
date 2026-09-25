package com.caprarim.colddrop

import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

object Network {
    fun validate(base: String, key: String) {
        val url = URL(base); val p = url.host.split('.').map { it.toIntOrNull() ?: -1 }
        val privateIP = p.size == 4 && p.all { it in 0..255 } && (p[0] == 10 || p[0] == 192 && p[1] == 168 || p[0] == 172 && p[1] in 16..31)
        require(url.protocol == "http" && privateIP && url.port == 48321 && url.userInfo == null && Regex("[a-f0-9]{64}").matches(key)) { "Use the pairing code from ColdDrop on your PC" }
    }
    fun open(job: JSONObject, path: String, method: String = "GET"): HttpURLConnection {
        validate(job.getString("base"), job.getString("key"))
        return (URL(job.getString("base") + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method; connectTimeout = 10000; readTimeout = 120000; instanceFollowRedirects = false
            setRequestProperty("Authorization", "Bearer " + job.getString("key"))
        }
    }
    fun request(job: JSONObject, path: String, method: String = "GET", body: ByteArray? = null, length: Int = body?.size ?: 0, mime: String = "application/json"): JSONObject {
        val connection = open(job, path, method)
        try {
            if (body != null) { connection.doOutput = true; connection.setFixedLengthStreamingMode(length); connection.setRequestProperty("Content-Type", mime); connection.outputStream.use { it.write(body, 0, length) } }
            return result(connection)
        } catch (e: Exception) { connection.disconnect(); throw e }
    }
    fun result(connection: HttpURLConnection): JSONObject {
        val code = connection.responseCode
        if (code !in 200..299) throw java.io.IOException(connection.errorStream?.bufferedReader()?.use { it.readText().take(240) } ?: "PC returned $code")
        val text = connection.inputStream.bufferedReader().use { it.readText() }
        return if (code == 204 || text.isBlank()) JSONObject() else JSONObject(text)
    }
}
