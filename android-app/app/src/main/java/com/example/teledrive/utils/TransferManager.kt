package com.example.teledrive.utils

import com.example.teledrive.data.local.FileEntity
import com.example.teledrive.data.repository.FileRepository
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.io.InputStream
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

enum class TransferState {
    PENDING,
    UPLOADING,
    COMPLETED,
    FAILED
}

data class UploadTask(
    val id: String = UUID.randomUUID().toString(),
    val fileName: String,
    val mimeType: String,
    val fileSize: Long,
    val folderId: String?,
    val inputStreamFactory: () -> InputStream,
    val isRetry: Boolean = false,
    val localFileIdToRetry: String? = null,
    var state: TransferState = TransferState.PENDING,
    var progressPercentage: Float = 0f,
    var bytesTransferred: Long = 0L,
    var speedBytesPerSec: Float = 0f,
    var errorMessage: String? = null
)

@Singleton
class TransferManager @Inject constructor(
    private val repository: FileRepository
) {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var isWorkerRunning = false

    private val _uploadQueue = MutableStateFlow<List<UploadTask>>(emptyList())
    val uploadQueue: StateFlow<List<UploadTask>> = _uploadQueue.asStateFlow()

    fun enqueueUpload(
        fileName: String,
        mimeType: String,
        fileSize: Long,
        folderId: String?,
        inputStreamFactory: () -> InputStream
    ) {
        val task = UploadTask(
            fileName = fileName,
            mimeType = mimeType,
            fileSize = fileSize,
            folderId = folderId,
            inputStreamFactory = inputStreamFactory
        )
        _uploadQueue.update { it + task }
        startWorkerIfNeeded()
    }

    fun enqueueRetry(file: FileEntity, inputStreamFactory: () -> InputStream) {
        val task = UploadTask(
            id = file.id,
            fileName = file.name,
            mimeType = file.mimeType,
            fileSize = file.size,
            folderId = file.folderId,
            inputStreamFactory = inputStreamFactory,
            isRetry = true,
            localFileIdToRetry = file.id
        )
        // Avoid duplicate retries
        if (_uploadQueue.value.none { it.id == file.id && it.state in listOf(TransferState.PENDING, TransferState.UPLOADING) }) {
            _uploadQueue.update { it + task }
            startWorkerIfNeeded()
        }
    }

    fun clearCompletedAndFailed() {
        _uploadQueue.update { tasks ->
            tasks.filter { it.state == TransferState.PENDING || it.state == TransferState.UPLOADING }
        }
    }

    private fun startWorkerIfNeeded() {
        if (isWorkerRunning) return
        isWorkerRunning = true

        scope.launch {
            while (true) {
                val nextTask = _uploadQueue.value.firstOrNull { it.state == TransferState.PENDING }
                if (nextTask == null) {
                    isWorkerRunning = false
                    break
                }

                processTask(nextTask)
            }
        }
    }

    private suspend fun processTask(task: UploadTask) {
        updateTaskState(task.id) { it.copy(state = TransferState.UPLOADING) }

        try {
            var lastTime = System.currentTimeMillis()
            var lastBytes = 0L

            val stream = task.inputStreamFactory()

            stream.use { input ->
                // If it's a retry, we need to handle replacing the local file entity.
                // For simplicity, we just use the regular upload stream, and the repository creates a new FileEntity.
                // In DriveViewModel, we should delete the old local_ entity after a successful retry.
                repository.uploadFileStream(
                    fileName = task.fileName,
                    mimeType = task.mimeType,
                    inputStream = input,
                    fileSize = task.fileSize,
                    folderId = task.folderId
                ) { bytesWritten, totalBytes ->
                    val now = System.currentTimeMillis()
                    val timeDeltaSec = (now - lastTime) / 1000f

                    if (timeDeltaSec >= 0.5f || bytesWritten == totalBytes) {
                        val bytesDelta = bytesWritten - lastBytes
                        val speedBytesPerSec = if (timeDeltaSec > 0) bytesDelta / timeDeltaSec else 0f
                        lastTime = now
                        lastBytes = bytesWritten

                        val percentage = if (totalBytes > 0) (bytesWritten.toFloat() / totalBytes) else 0f

                        updateTaskState(task.id) {
                            it.copy(
                                progressPercentage = percentage,
                                bytesTransferred = bytesWritten,
                                speedBytesPerSec = speedBytesPerSec
                            )
                        }
                    }
                }
            }

            updateTaskState(task.id) {
                it.copy(
                    state = TransferState.COMPLETED,
                    progressPercentage = 1f,
                    bytesTransferred = task.fileSize,
                    speedBytesPerSec = 0f
                )
            }

        } catch (e: Exception) {
            e.printStackTrace()
            updateTaskState(task.id) {
                it.copy(
                    state = TransferState.FAILED,
                    errorMessage = e.message ?: "Unknown upload error",
                    speedBytesPerSec = 0f
                )
            }
        }
    }

    private fun updateTaskState(taskId: String, updateOp: (UploadTask) -> UploadTask) {
        _uploadQueue.update { tasks ->
            tasks.map { if (it.id == taskId) updateOp(it) else it }
        }
    }
}
