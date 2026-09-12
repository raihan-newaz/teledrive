package com.example.teledrive.services

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.example.teledrive.data.repository.DatabaseBackupManager
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject

@HiltWorker
class DatabaseBackupWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val backupManager: DatabaseBackupManager
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        return try {
            backupManager.backupDatabaseToTelegram()
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }
}
