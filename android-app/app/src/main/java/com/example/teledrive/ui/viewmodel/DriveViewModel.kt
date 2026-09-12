package com.example.teledrive.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.teledrive.data.local.FileEntity
import com.example.teledrive.data.local.FolderEntity
import com.example.teledrive.data.repository.FileRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import java.io.InputStream
import javax.inject.Inject

enum class FileCategory(val label: String, val mimePrefix: String?) {
    ALL("All", null),
    IMAGES("Images", "image/"),
    VIDEOS("Videos", "video/"),
    AUDIO("Audio", "audio/"),
    DOCUMENTS("Documents", "application/pdf"),
    ARCHIVES("Archives", "application/zip")
}

data class UploadState(
    val isUploading: Boolean = false,
    val fileName: String = "",
    val progressPercentage: Float = 0f,
    val speedFormatted: String = "0 KB/s",
    val etaFormatted: String = "Calculating...",
    val bytesTransferredFormatted: String = "0 KB",
    val totalBytesFormatted: String = "0 KB"
)

@HiltViewModel
class DriveViewModel @Inject constructor(
    private val repository: FileRepository
) : ViewModel() {

    private val _currentFolderId = MutableStateFlow<String?>(null)
    val currentFolderId: StateFlow<String?> = _currentFolderId.asStateFlow()

    private val _selectedCategory = MutableStateFlow(FileCategory.ALL)
    val selectedCategory: StateFlow<FileCategory> = _selectedCategory.asStateFlow()

    private val _searchQuery = MutableStateFlow("")
    val searchQuery: StateFlow<String> = _searchQuery.asStateFlow()

    private val _isGridView = MutableStateFlow(false)
    val isGridView: StateFlow<Boolean> = _isGridView.asStateFlow()

    private val _selectedFileIds = MutableStateFlow<Set<String>>(emptySet())
    val selectedFileIds: StateFlow<Set<String>> = _selectedFileIds.asStateFlow()

    private val _files = MutableStateFlow<List<FileEntity>>(emptyList())
    val files: StateFlow<List<FileEntity>> = _files.asStateFlow()

    private val _trashedFiles = MutableStateFlow<List<FileEntity>>(emptyList())
    val trashedFiles: StateFlow<List<FileEntity>> = _trashedFiles.asStateFlow()

    private val _folders = MutableStateFlow<List<FolderEntity>>(emptyList())
    val folders: StateFlow<List<FolderEntity>> = _folders.asStateFlow()

    private val _isUploading = MutableStateFlow(false)
    val isUploading: StateFlow<Boolean> = _isUploading.asStateFlow()

    private val _uploadState = MutableStateFlow(UploadState())
    val uploadState: StateFlow<UploadState> = _uploadState.asStateFlow()

    private val _toastMessage = MutableSharedFlow<String>()
    val toastMessage: SharedFlow<String> = _toastMessage.asSharedFlow()

    private val _shareTokenEvent = MutableSharedFlow<String>()
    val shareTokenEvent: SharedFlow<String> = _shareTokenEvent.asSharedFlow()

    init {
        loadContents()
    }

    fun setCategory(category: FileCategory) {
        _selectedCategory.value = category
        loadContents()
    }

    fun setSearchQuery(query: String) {
        _searchQuery.value = query
        loadContents()
    }

    fun toggleViewMode() {
        _isGridView.value = !_isGridView.value
    }

    fun navigateToFolder(folderId: String?) {
        _currentFolderId.value = folderId
        loadContents()
    }

    fun toggleFileSelection(fileId: String) {
        val current = _selectedFileIds.value.toMutableSet()
        if (current.contains(fileId)) {
            current.remove(fileId)
        } else {
            current.add(fileId)
        }
        _selectedFileIds.value = current
    }

    fun clearSelection() {
        _selectedFileIds.value = emptySet()
    }

    fun batchDeleteSelected() {
        viewModelScope.launch {
            val selected = _selectedFileIds.value
            selected.forEach { fileId ->
                repository.moveToTrash(fileId)
            }
            clearSelection()
            _toastMessage.emit("${selected.size} items moved to Trash")
        }
    }

    fun batchMoveSelected(targetFolderId: String?) {
        viewModelScope.launch {
            val selected = _selectedFileIds.value
            selected.forEach { fileId ->
                repository.moveFile(fileId, targetFolderId)
            }
            clearSelection()
            _toastMessage.emit("${selected.size} items moved")
        }
    }

    fun batchStarSelected() {
        viewModelScope.launch {
            val selected = _selectedFileIds.value
            selected.forEach { fileId ->
                repository.toggleStar(fileId, true)
            }
            clearSelection()
            _toastMessage.emit("${selected.size} items starred")
        }
    }

    fun batchDownloadSelected() {
        viewModelScope.launch {
            val selected = _selectedFileIds.value
            var successCount = 0
            selected.forEach { fileId ->
                try {
                    repository.downloadFileToDevice(fileId)
                    successCount++
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
            clearSelection()
            _toastMessage.emit("Downloaded $successCount files to Downloads folder")
        }
    }

    fun loadContents() {
        viewModelScope.launch {
            val query = _searchQuery.value
            val category = _selectedCategory.value
            val folderId = _currentFolderId.value

            if (query.isNotBlank()) {
                repository.searchFiles(query).collectLatest { _files.value = it }
            } else if (category.mimePrefix != null) {
                repository.getFilesByCategory(category.mimePrefix).collectLatest { _files.value = it }
            } else {
                repository.getFilesInFolder(folderId).collectLatest { _files.value = it }
            }
        }

        viewModelScope.launch {
            repository.getTrashedFiles().collectLatest {
                _trashedFiles.value = it
            }
        }

        viewModelScope.launch {
            repository.getFoldersInParent(_currentFolderId.value).collectLatest {
                _folders.value = it
            }
        }
    }

    fun uploadFile(name: String, mimeType: String, bytes: ByteArray) {
        viewModelScope.launch {
            uploadFileStream(name, mimeType, bytes.inputStream(), bytes.size.toLong())
        }
    }

    suspend fun uploadFileStream(name: String, mimeType: String, inputStream: InputStream, fileSize: Long) {
        _isUploading.value = true
        var lastTime = System.currentTimeMillis()
        var lastBytes = 0L

        _uploadState.value = UploadState(
            isUploading = true,
            fileName = name,
            progressPercentage = 0f,
            speedFormatted = "0 KB/s",
            etaFormatted = "Calculating...",
            bytesTransferredFormatted = "0 KB",
            totalBytesFormatted = formatSize(fileSize)
        )

        try {
            repository.uploadFileStream(name, mimeType, inputStream, fileSize, _currentFolderId.value) { bytesWritten, totalBytes ->
                val now = System.currentTimeMillis()
                val timeDeltaSec = (now - lastTime) / 1000f
                if (timeDeltaSec >= 0.2f || bytesWritten == totalBytes) {
                    val bytesDelta = bytesWritten - lastBytes
                    val speedBytesPerSec = if (timeDeltaSec > 0) bytesDelta / timeDeltaSec else 0f
                    lastTime = now
                    lastBytes = bytesWritten

                    val remainingBytes = (totalBytes - bytesWritten).coerceAtLeast(0)
                    val etaSeconds = if (speedBytesPerSec > 0) (remainingBytes / speedBytesPerSec).toLong() else 0L
                    val percentage = if (totalBytes > 0) (bytesWritten.toFloat() / totalBytes) else 0f

                    _uploadState.value = UploadState(
                        isUploading = true,
                        fileName = name,
                        progressPercentage = percentage,
                        speedFormatted = formatSpeed(speedBytesPerSec),
                        etaFormatted = formatEta(etaSeconds),
                        bytesTransferredFormatted = formatSize(bytesWritten),
                        totalBytesFormatted = formatSize(totalBytes)
                    )
                }
            }
            _toastMessage.emit("File uploaded successfully!")
        } catch (e: Exception) {
            e.printStackTrace()
            _toastMessage.emit("Upload Notice: ${e.message ?: "Saved locally"}")
        } finally {
            _isUploading.value = false
            _uploadState.value = UploadState(isUploading = false)
        }
    }

    fun downloadFileToDevice(file: FileEntity) {
        viewModelScope.launch {
            try {
                val destFile = repository.downloadFileToDevice(file.id)
                _toastMessage.emit("Downloaded to Downloads/${destFile.name}")
            } catch (e: Exception) {
                e.printStackTrace()
                _toastMessage.emit("Download Failed: ${e.message}")
            }
        }
    }

    fun createFolder(name: String) {
        viewModelScope.launch {
            repository.createFolder(name, _currentFolderId.value)
        }
    }

    fun renameFolder(folder: FolderEntity, newName: String) {
        viewModelScope.launch {
            repository.renameFolder(folder.id, newName)
        }
    }

    fun moveFolder(folder: FolderEntity, targetParentId: String?) {
        viewModelScope.launch {
            repository.moveFolder(folder.id, targetParentId)
        }
    }

    fun deleteFolder(folder: FolderEntity) {
        viewModelScope.launch {
            repository.deleteFolder(folder.id)
        }
    }

    fun renameFile(file: FileEntity, newName: String) {
        viewModelScope.launch {
            repository.renameFile(file.id, newName)
        }
    }

    fun moveFile(file: FileEntity, targetFolderId: String?) {
        viewModelScope.launch {
            repository.moveFile(file.id, targetFolderId)
        }
    }

    fun lockFolder(folderId: String, password: String) {
        viewModelScope.launch {
            repository.lockFolder(folderId, password)
        }
    }

    fun generateShareLink(fileId: String) {
        viewModelScope.launch {
            val token = repository.generateShareToken(fileId)
            _shareTokenEvent.emit(token)
        }
    }

    fun toggleStar(file: FileEntity) {
        viewModelScope.launch {
            repository.toggleStar(file.id, !file.isStarred)
        }
    }

    fun moveToTrash(file: FileEntity) {
        viewModelScope.launch {
            repository.moveToTrash(file.id)
        }
    }

    fun restoreFromTrash(file: FileEntity) {
        viewModelScope.launch {
            repository.restoreFromTrash(file.id)
        }
    }

    fun deletePermanently(file: FileEntity) {
        viewModelScope.launch {
            repository.deletePermanently(file.id)
        }
    }

    private fun formatSize(bytes: Long): String {
        if (bytes < 1024) return "$bytes B"
        val kb = bytes / 1024f
        if (kb < 1024) return String.format("%.1f KB", kb)
        val mb = kb / 1024f
        if (mb < 1024) return String.format("%.1f MB", mb)
        val gb = mb / 1024f
        return String.format("%.2f GB", gb)
    }

    private fun formatSpeed(bytesPerSec: Float): String {
        if (bytesPerSec < 1024) return String.format("%.0f B/s", bytesPerSec)
        val kbPerSec = bytesPerSec / 1024f
        if (kbPerSec < 1024) return String.format("%.1f KB/s", kbPerSec)
        val mbPerSec = kbPerSec / 1024f
        return String.format("%.1f MB/s", mbPerSec)
    }

    private fun formatEta(seconds: Long): String {
        if (seconds <= 0) return "0s"
        val mins = seconds / 60
        val secs = seconds % 60
        return if (mins > 0) "${mins}m ${secs}s" else "${secs}s"
    }
}
