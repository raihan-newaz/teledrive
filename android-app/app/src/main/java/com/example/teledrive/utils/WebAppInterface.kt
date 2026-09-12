package com.example.teledrive.utils

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.VibrationEffect
import android.os.Vibrator
import android.webkit.JavascriptInterface
import android.widget.Toast
import com.example.teledrive.MainActivity
import com.example.teledrive.services.SyncForegroundService

class WebAppInterface(private val context: Context) {

    @JavascriptInterface
    fun showToast(message: String) {
        Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
    }

    @JavascriptInterface
    fun startBackgroundSync(title: String, message: String) {
        SyncForegroundService.start(context, title, message)
    }

    @JavascriptInterface
    fun updateSyncProgress(progress: Int, max: Int, message: String) {
        SyncForegroundService.updateProgress(context, progress, max, message)
    }

    @JavascriptInterface
    fun stopBackgroundSync() {
        SyncForegroundService.stop(context)
    }

    @JavascriptInterface
    fun vibrate(milliseconds: Long) {
        val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createOneShot(milliseconds, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(milliseconds)
        }
    }

    @JavascriptInterface
    fun shareText(text: String, title: String = "Share from TeleDrive") {
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
            putExtra(Intent.EXTRA_SUBJECT, title)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(Intent.createChooser(intent, title).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
    }

    @JavascriptInterface
    fun downloadFileNative(url: String, filename: String, mimeType: String = "*/*") {
        try {
            val request = DownloadManager.Request(Uri.parse(url)).apply {
                setTitle(filename)
                setDescription("Downloading file from TeleDrive...")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)
                setMimeType(mimeType)
            }
            val downloadManager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            downloadManager.enqueue(request)
            Toast.makeText(context, "Download started: $filename", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(context, "Download failed: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    @JavascriptInterface
    fun setServerUrl(url: String) {
        val prefs = context.getSharedPreferences("teledrive_prefs", Context.MODE_PRIVATE)
        prefs.edit().putString("server_url", url).apply()
    }

    @JavascriptInterface
    fun setAuthToken(token: String) {
        val prefs = context.getSharedPreferences("teledrive_prefs", Context.MODE_PRIVATE)
        prefs.edit().putString("auth_token", token).apply()
    }

    @JavascriptInterface
    fun saveBackupSettings(json: String) {
        val prefs = context.getSharedPreferences("teledrive_backup_prefs", Context.MODE_PRIVATE)
        prefs.edit().putString("backup_settings", json).apply()
        // Here we would also reschedule the WorkManager task
    }

    @JavascriptInterface
    fun getBackupSettings(): String {
        val prefs = context.getSharedPreferences("teledrive_backup_prefs", Context.MODE_PRIVATE)
        return prefs.getString("backup_settings", "{}") ?: "{}"
    }

    @JavascriptInterface
    fun pickBackupFolder() {
        (context as? MainActivity)?.openFolderPicker()
    }

    @JavascriptInterface
    fun triggerInstantBackup() {
        // Trigger manual run of BackupWorker
    }
}
