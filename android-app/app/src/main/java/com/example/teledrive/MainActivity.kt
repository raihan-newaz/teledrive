package com.example.teledrive

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.documentfile.provider.DocumentFile
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.lifecycleScope
import com.example.teledrive.data.repository.DatabaseBackupManager
import com.example.teledrive.data.repository.FileRepository
import com.example.teledrive.services.SyncForegroundService
import com.example.teledrive.ui.screens.*
import com.example.teledrive.ui.theme.TeleDriveTheme
import com.example.teledrive.ui.viewmodel.DriveViewModel
import com.example.teledrive.utils.CryptoEngine
import com.example.teledrive.utils.SessionManager
import com.example.teledrive.webdav.LocalWebDavServer
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import javax.inject.Inject

enum class ScreenState {
    SETUP,
    UNLOCK,
    HOME,
    SETTINGS,
    BACKUP_SETTINGS,
    DECRYPT_TOOL,
    IMAGE_VIEWER,
    MEDIA_VIEWER,
    DOCUMENT_VIEWER
}

@OptIn(ExperimentalMaterial3Api::class)
@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var webDavServer: LocalWebDavServer
    @Inject lateinit var fileRepository: FileRepository
    @Inject lateinit var dbBackupManager: DatabaseBackupManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        setContent {
            TeleDriveTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    val prefs = remember { getSharedPreferences("teledrive_prefs", MODE_PRIVATE) }
                    var currentScreen by remember {
                        mutableStateOf(
                            if (prefs.getBoolean("setup_complete", false)) ScreenState.UNLOCK else ScreenState.SETUP
                        )
                    }

                    var selectedMediaUri by remember { mutableStateOf<Uri?>(null) }
                    var selectedMediaTitle by remember { mutableStateOf("") }
                    var selectedDocFile by remember { mutableStateOf<File?>(null) }
                    var isProcessingFile by remember { mutableStateOf(false) }

                    val viewModel: DriveViewModel = hiltViewModel()
                    val files by viewModel.files.collectAsState()
                    val trashedFiles by viewModel.trashedFiles.collectAsState()
                    val folders by viewModel.folders.collectAsState()
                    val currentFolderId by viewModel.currentFolderId.collectAsState()
                    val selectedCategory by viewModel.selectedCategory.collectAsState()
                    val selectedFileIds by viewModel.selectedFileIds.collectAsState()
                    val isGridView by viewModel.isGridView.collectAsState()
                    val searchQuery by viewModel.searchQuery.collectAsState()
                    val uploadState by viewModel.uploadState.collectAsState()

                    // Toast message listener
                    LaunchedEffect(Unit) {
                        viewModel.toastMessage.collectLatest { msg ->
                            Toast.makeText(this@MainActivity, msg, Toast.LENGTH_SHORT).show()
                        }
                    }

                    // Request runtime permissions on launch
                    val permissionsLauncher = rememberLauncherForActivityResult(
                        contract = ActivityResultContracts.RequestMultiplePermissions()
                    ) { _ -> }

                    LaunchedEffect(Unit) {
                        val permissionsToRequest = mutableListOf<String>()
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            permissionsToRequest.add(Manifest.permission.POST_NOTIFICATIONS)
                            permissionsToRequest.add(Manifest.permission.READ_MEDIA_IMAGES)
                            permissionsToRequest.add(Manifest.permission.READ_MEDIA_VIDEO)
                            permissionsToRequest.add(Manifest.permission.READ_MEDIA_AUDIO)
                        } else {
                            permissionsToRequest.add(Manifest.permission.READ_EXTERNAL_STORAGE)
                        }
                        permissionsLauncher.launch(permissionsToRequest.toTypedArray())

                        if (prefs.getBoolean("setup_complete", false)) {
                            SessionManager.apiId = prefs.getString("api_id", null)
                            SessionManager.apiHash = prefs.getString("api_hash", null)
                            SessionManager.botToken = prefs.getString("bot_token", null)
                            SessionManager.chatId = prefs.getString("chat_id", null)
                            webDavServer.start()
                        }
                    }

                    val filePickerLauncher = rememberLauncherForActivityResult(
                        contract = ActivityResultContracts.GetMultipleContents()
                    ) { uris: List<Uri> ->
                        if (uris.isNotEmpty()) {
                            lifecycleScope.launch(Dispatchers.IO) {
                                val contentResolver = applicationContext.contentResolver
                                uris.forEach { uri ->
                                    var fileName = "uploaded_file"
                                    var fileSize = 0L
                                    val mimeType = contentResolver.getType(uri) ?: "application/octet-stream"

                                    contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                                        if (cursor.moveToFirst()) {
                                            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                                            val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                                            if (nameIndex != -1) fileName = cursor.getString(nameIndex)
                                            if (sizeIndex != -1) fileSize = cursor.getLong(sizeIndex)
                                        }
                                    }

                                    try {
                                        contentResolver.openInputStream(uri)?.use { inputStream ->
                                            withContext(Dispatchers.Main) {
                                                SyncForegroundService.start(this@MainActivity, "TeleDrive Upload", "Uploading $fileName")
                                                viewModel.uploadFileStream(fileName, mimeType, inputStream, fileSize)
                                            }
                                        }
                                    } catch (e: Exception) {
                                        withContext(Dispatchers.Main) {
                                            Toast.makeText(this@MainActivity, "Error reading file: ${e.message}", Toast.LENGTH_SHORT).show()
                                        }
                                    }
                                }
                                withContext(Dispatchers.Main) {
                                    SyncForegroundService.stop(this@MainActivity)
                                }
                            }
                        }
                    }

                    val folderPickerLauncher = rememberLauncherForActivityResult(
                        contract = ActivityResultContracts.OpenDocumentTree()
                    ) { treeUri: Uri? ->
                        treeUri?.let { uri ->
                            lifecycleScope.launch(Dispatchers.IO) {
                                val documentFile = DocumentFile.fromTreeUri(applicationContext, uri) ?: return@launch
                                val folderName = documentFile.name ?: "Uploaded Folder"

                                withContext(Dispatchers.Main) {
                                    viewModel.createFolder(folderName)
                                }

                                val children = documentFile.listFiles()
                                val contentResolver = applicationContext.contentResolver

                                children.filter { it.isFile }.forEach { doc ->
                                    val childUri = doc.uri
                                    val childName = doc.name ?: "file"
                                    val mimeType = doc.type ?: "application/octet-stream"
                                    val fileSize = doc.length()

                                    try {
                                        contentResolver.openInputStream(childUri)?.use { inputStream ->
                                            withContext(Dispatchers.Main) {
                                                SyncForegroundService.start(this@MainActivity, "TeleDrive Folder Upload", "Uploading $childName")
                                                viewModel.uploadFileStream(childName, mimeType, inputStream, fileSize)
                                            }
                                        }
                                    } catch (e: Exception) {
                                        e.printStackTrace()
                                    }
                                }

                                withContext(Dispatchers.Main) {
                                    SyncForegroundService.stop(this@MainActivity)
                                    Toast.makeText(this@MainActivity, "Folder '$folderName' uploaded successfully!", Toast.LENGTH_LONG).show()
                                }
                            }
                        }
                    }

                    if (isProcessingFile) {
                        AlertDialog(
                            onDismissRequest = {},
                            confirmButton = {},
                            title = { Text("Opening File") },
                            text = {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    CircularProgressIndicator(modifier = Modifier.size(28.dp))
                                    Spacer(modifier = Modifier.width(16.dp))
                                    Text("Decrypting file from Telegram Cloud...")
                                }
                            }
                        )
                    }

                    when (currentScreen) {
                        ScreenState.SETUP -> {
                            SetupScreen(
                                onTestConnection = { botToken, chatId, onResult ->
                                    lifecycleScope.launch(Dispatchers.IO) {
                                        val result = fileRepository.testConnection(botToken, chatId)
                                        withContext(Dispatchers.Main) {
                                            onResult(result)
                                        }
                                    }
                                },
                                onComplete = { apiId, apiHash, botToken, chatId, password, _ ->
                                    val salt = CryptoEngine.generateSalt()
                                    val key = CryptoEngine.deriveKey(password.toCharArray(), salt)

                                    SessionManager.apiId = apiId
                                    SessionManager.apiHash = apiHash
                                    SessionManager.masterKey = key
                                    SessionManager.botToken = botToken
                                    SessionManager.chatId = chatId

                                    prefs.edit().apply {
                                        putString("api_id", apiId)
                                        putString("api_hash", apiHash)
                                        putString("bot_token", botToken)
                                        putString("chat_id", chatId)
                                        putString("salt", CryptoEngine.toBase64(salt))
                                        putString("master_pass", password)
                                        putBoolean("setup_complete", true)
                                        apply()
                                    }

                                    webDavServer.start()
                                    currentScreen = ScreenState.HOME
                                    Toast.makeText(this@MainActivity, "Connected to Telegram Cloud Drive!", Toast.LENGTH_SHORT).show()
                                }
                            )
                        }

                        ScreenState.UNLOCK -> {
                            UnlockScreen(
                                onUnlocked = {
                                    currentScreen = ScreenState.HOME
                                }
                            )
                        }

                        ScreenState.HOME -> {
                            HomeScreen(
                                files = files,
                                trashedFiles = trashedFiles,
                                folders = folders,
                                currentFolderId = currentFolderId,
                                selectedCategory = selectedCategory,
                                isGridView = isGridView,
                                searchQuery = searchQuery,
                                uploadState = uploadState,
                                selectedFileIds = selectedFileIds,
                                onToggleFileSelection = { viewModel.toggleFileSelection(it) },
                                onClearSelection = { viewModel.clearSelection() },
                                onBatchDownload = { viewModel.batchDownloadSelected() },
                                onBatchDelete = { viewModel.batchDeleteSelected() },
                                onBatchMove = { viewModel.batchMoveSelected(null) },
                                onBatchStar = { viewModel.batchStarSelected() },
                                onCategorySelect = { viewModel.setCategory(it) },
                                onSearchQueryChange = { viewModel.setSearchQuery(it) },
                                onToggleViewMode = { viewModel.toggleViewMode() },
                                onUploadClick = { filePickerLauncher.launch("*/*") },
                                onUploadFolderClick = { folderPickerLauncher.launch(null) },
                                onCreateFolderClick = { folderName -> viewModel.createFolder(folderName) },
                                onFolderClick = { folder -> viewModel.navigateToFolder(folder.id) },
                                onNavigateBackFolder = { viewModel.navigateToFolder(null) },
                                onFileClick = { fileEntity ->
                                    if (fileEntity.mimeType.startsWith("video/") || fileEntity.mimeType.startsWith("audio/")) {
                                        // INSTANT STREAMING PLAYBACK - Bypass full download
                                        selectedMediaUri = Uri.parse("http://127.0.0.1:8080/stream/${fileEntity.id}")
                                        selectedMediaTitle = fileEntity.name
                                        currentScreen = ScreenState.MEDIA_VIEWER
                                    } else {
                                        // Standard Download & Decrypt for Images and Documents
                                        lifecycleScope.launch {
                                            isProcessingFile = true
                                            try {
                                                val decryptedBytes = withContext(Dispatchers.IO) {
                                                    fileRepository.downloadAndDecryptFile(fileEntity.id)
                                                }
                                                val tempFile = File(cacheDir, fileEntity.name)
                                                tempFile.writeBytes(decryptedBytes)

                                                val uri = FileProvider.getUriForFile(
                                                    this@MainActivity,
                                                    "$packageName.fileprovider",
                                                    tempFile
                                                )

                                                selectedMediaUri = uri
                                                selectedMediaTitle = fileEntity.name
                                                selectedDocFile = tempFile

                                                when {
                                                    fileEntity.mimeType.startsWith("image/") -> {
                                                        currentScreen = ScreenState.IMAGE_VIEWER
                                                    }
                                                    fileEntity.mimeType == "application/pdf" || fileEntity.name.endsWith(".txt") || fileEntity.name.endsWith(".kt") || fileEntity.name.endsWith(".json") -> {
                                                        currentScreen = ScreenState.DOCUMENT_VIEWER
                                                    }
                                                    else -> {
                                                        val intent = Intent(Intent.ACTION_VIEW).apply {
                                                            setDataAndType(uri, fileEntity.mimeType)
                                                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                                        }
                                                        startActivity(Intent.createChooser(intent, "Open ${fileEntity.name}"))
                                                    }
                                                }
                                            } catch (e: Exception) {
                                                Toast.makeText(this@MainActivity, "Failed to open file: ${e.message}", Toast.LENGTH_LONG).show()
                                            } finally {
                                                isProcessingFile = false
                                            }
                                        }
                                    }
                                },
                                onDownloadFile = { file -> viewModel.downloadFileToDevice(file) },
                                onStarClick = { file -> viewModel.toggleStar(file) },
                                onTrashClick = { file -> viewModel.moveToTrash(file) },
                                onRestoreClick = { file -> viewModel.restoreFromTrash(file) },
                                onDeletePermanentlyClick = { file -> viewModel.deletePermanently(file) },
                                onOpenBackupSettings = { currentScreen = ScreenState.BACKUP_SETTINGS },
                                onOpenSettings = { currentScreen = ScreenState.SETTINGS },
                                onOpenDecryptTool = { currentScreen = ScreenState.DECRYPT_TOOL },
                                onRefresh = { viewModel.loadContents() },
                                onRenameFile = { file, newName -> viewModel.renameFile(file, newName) },
                                onMoveFile = { file, targetFolderId -> viewModel.moveFile(file, targetFolderId) },
                                onRenameFolder = { folder, newName -> viewModel.renameFolder(folder, newName) },
                                onMoveFolder = { folder, targetParentId -> viewModel.moveFolder(folder, targetParentId) },
                                onDeleteFolder = { folder -> viewModel.deleteFolder(folder) }
                            )
                        }

                        ScreenState.SETTINGS -> {
                            SettingsScreen(
                                onBack = { currentScreen = ScreenState.HOME },
                                onTestConnection = { botToken, chatId, onResult ->
                                    lifecycleScope.launch(Dispatchers.IO) {
                                        val result = fileRepository.testConnection(botToken, chatId)
                                        withContext(Dispatchers.Main) {
                                            onResult(result)
                                        }
                                    }
                                },
                                onBackupDatabase = { onSuccess, onError ->
                                    lifecycleScope.launch(Dispatchers.IO) {
                                        try {
                                            dbBackupManager.backupDatabaseToTelegram()
                                            withContext(Dispatchers.Main) { onSuccess() }
                                        } catch (e: Exception) {
                                            withContext(Dispatchers.Main) { onError(e.message ?: "Backup Failed") }
                                        }
                                    }
                                },
                                onRestoreDatabase = { onSuccess, onError ->
                                    lifecycleScope.launch(Dispatchers.IO) {
                                        try {
                                            dbBackupManager.restoreDatabaseFromTelegram()
                                            withContext(Dispatchers.Main) {
                                                onSuccess()
                                                viewModel.loadContents()
                                            }
                                        } catch (e: Exception) {
                                            withContext(Dispatchers.Main) { onError(e.message ?: "Restore Failed") }
                                        }
                                    }
                                }
                            )
                        }

                        ScreenState.DECRYPT_TOOL -> {
                            DecryptToolScreen(
                                onBack = { currentScreen = ScreenState.HOME }
                            )
                        }

                        ScreenState.BACKUP_SETTINGS -> {
                            BackupSettingsScreen(
                                onBack = { currentScreen = ScreenState.HOME }
                            )
                        }

                        ScreenState.IMAGE_VIEWER -> {
                            selectedMediaUri?.let { uri ->
                                ImageViewer(
                                    imageUri = uri,
                                    title = selectedMediaTitle,
                                    onBack = { currentScreen = ScreenState.HOME }
                                )
                            }
                        }

                        ScreenState.MEDIA_VIEWER -> {
                            selectedMediaUri?.let { uri ->
                                MediaViewer(
                                    mediaUri = uri,
                                    title = selectedMediaTitle,
                                    onBack = { currentScreen = ScreenState.HOME }
                                )
                            }
                        }

                        ScreenState.DOCUMENT_VIEWER -> {
                            selectedDocFile?.let { file ->
                                DocumentViewer(
                                    file = file,
                                    title = selectedMediaTitle,
                                    onBack = { currentScreen = ScreenState.HOME }
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        webDavServer.stop()
    }

    fun openFolderPicker() {
        // Folder picker callback
    }
}
