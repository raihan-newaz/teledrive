package com.example.teledrive.services

import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.provider.MediaStore
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.example.teledrive.data.repository.FileRepository
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@HiltWorker
class CameraBackupWorker @AssistedInject constructor(
    @Assisted private val context: Context,
    @Assisted params: WorkerParameters,
    private val repository: FileRepository
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        try {
            val prefs = context.getSharedPreferences("teledrive_backup_prefs", Context.MODE_PRIVATE)
            val lastBackupTime = prefs.getLong("last_backup_timestamp", System.currentTimeMillis() - 86400000L)

            val newMediaFiles = scanMediaAfterTimestamp(lastBackupTime)
            for (media in newMediaFiles) {
                try {
                    repository.uploadFile(
                        fileName = media.name,
                        mimeType = media.mimeType,
                        data = media.bytes,
                        folderId = null
                    )
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }

            prefs.edit().putLong("last_backup_timestamp", System.currentTimeMillis()).apply()
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }

    private data class MediaItem(
        val name: String,
        val mimeType: String,
        val bytes: ByteArray
    )

    private fun scanMediaAfterTimestamp(timestampSeconds: Long): List<MediaItem> {
        val list = mutableListOf<MediaItem>()
        val contentResolver: ContentResolver = context.contentResolver

        val projection = arrayOf(
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.MediaColumns._ID
        )

        val selection = "${MediaStore.MediaColumns.DATE_ADDED} > ?"
        val selectionArgs = arrayOf((timestampSeconds / 1000).toString())

        val uris = arrayOf(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        )

        for (uri in uris) {
            contentResolver.query(uri, projection, selection, selectionArgs, null)?.use { cursor ->
                val nameIndex = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
                val mimeIndex = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE)
                val idIndex = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)

                while (cursor.moveToNext()) {
                    val name = cursor.getString(nameIndex) ?: "media_${System.currentTimeMillis()}"
                    val mimeType = cursor.getString(mimeIndex) ?: "image/jpeg"
                    val id = cursor.getLong(idIndex)
                    val contentUri = ContentUris.withAppendedId(uri, id)

                    try {
                        contentResolver.openInputStream(contentUri)?.use { stream ->
                            val bytes = stream.readBytes()
                            if (bytes.isNotEmpty()) {
                                list.add(MediaItem(name, mimeType, bytes))
                            }
                        }
                    } catch (e: Exception) {
                        e.printStackTrace()
                    }
                }
            }
        }
        return list
    }
}
