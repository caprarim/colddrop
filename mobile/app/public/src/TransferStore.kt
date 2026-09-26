package com.caprarim.colddrop

import android.content.Context
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject

object TransferStore {
    const val ACTION = "com.caprarim.colddrop.TRANSFER"
    @Synchronized fun all(context: Context): JSONArray = JSONArray(context.getSharedPreferences("transfers", Context.MODE_PRIVATE).getString("jobs", "[]"))
    @Synchronized fun put(context: Context, job: JSONObject) {
        val source = all(context); val result = JSONArray(); result.put(job)
        for (i in 0 until source.length()) { val previous = source.getJSONObject(i); if (previous.getString("id") != job.getString("id") && (result.length() < 100 || previous.optString("status") != "complete")) result.put(previous) }
        context.getSharedPreferences("transfers", Context.MODE_PRIVATE).edit().putString("jobs", result.toString()).commit()
        val public = JSONObject().put("id", job.getString("id")).put("name", job.optString("name")).put("size", job.optLong("size")).put("sent", job.optLong("sent")).put("status", job.optString("status")).put("error", job.optString("error"))
        context.sendBroadcast(Intent(ACTION).setPackage(context.packageName).putExtra("transfer", public.toString()))
    }
    @Synchronized fun queued(context: Context): JSONObject? { val jobs = all(context); for (i in jobs.length() - 1 downTo 0) { val j = jobs.getJSONObject(i); if (j.optString("status") == "queued") return j }; return null }
    @Synchronized fun retry(context: Context, id: String) { val jobs = all(context); for (i in 0 until jobs.length()) { val j = jobs.getJSONObject(i); if (j.getString("id") == id && j.optString("status") == "failed") { j.put("status", "queued").remove("error"); put(context, j) } } }
    @Synchronized fun clearFinished(context: Context): JSONArray {
        val jobs = all(context); val kept = JSONArray()
        for (i in 0 until jobs.length()) { val j = jobs.getJSONObject(i); if (j.optString("status") !in listOf("complete", "failed")) kept.put(j) }
        context.getSharedPreferences("transfers", Context.MODE_PRIVATE).edit().putString("jobs", kept.toString()).commit()
        return kept
    }
    @Synchronized fun recover(context: Context) {
        if (TransferService.running) return
        val jobs = all(context)
        for (i in 0 until jobs.length()) { val j = jobs.getJSONObject(i); if (j.optString("status") in listOf("uploading", "downloading", "queued")) { j.put("status", "failed").put("error", "Transfer interrupted. Tap Retry to resume."); put(context, j) } }
    }
}
