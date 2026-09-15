package com.example.teledrive.ui.screens

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshContainer
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.example.teledrive.R
import com.example.teledrive.data.local.FileEntity
import com.example.teledrive.data.local.FolderEntity
import com.example.teledrive.ui.viewmodel.FileCategory
import com.example.teledrive.ui.viewmodel.UploadState
import com.example.teledrive.utils.NetworkObserver
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

enum class HomeTab(val label: String, val icon: ImageVector) {
    HOME("Home", Icons.Default.Home),
    STARRED("Starred", Icons.Default.Star),
    FOLDERS("Folders", Icons.Default.Folder),
    TRASH("Trash", Icons.Default.Delete)
}

fun formatFileSize(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val kb = bytes / 1024f
    if (kb < 1024) return String.format("%.1f KB", kb)
    val mb = kb / 1024f
    if (mb < 1024) return String.format("%.1f MB", mb)
    val gb = mb / 1024f
    return String.format("%.2f GB", gb)
}

fun formatDate(timestamp: Long): String {
    val sdf = SimpleDateFormat("MMM dd, yyyy", Locale.getDefault())
    return sdf.format(Date(timestamp))
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun HomeScreen(
    files: List<FileEntity>,
    trashedFiles: List<FileEntity>,
    folders: List<FolderEntity>,
    currentFolderId: String?,
    selectedCategory: FileCategory,
    isGridView: Boolean,
    searchQuery: String,
    uploadState: UploadState,
    selectedFileIds: Set<String> = emptySet(),
    onToggleFileSelection: (String) -> Unit = {},
    onClearSelection: () -> Unit = {},
    onBatchDownload: () -> Unit = {},
    onBatchDelete: () -> Unit = {},
    onBatchMove: () -> Unit = {},
    onBatchStar: () -> Unit = {},
    onCategorySelect: (FileCategory) -> Unit,
    onSearchQueryChange: (String) -> Unit,
    onToggleViewMode: () -> Unit,
    onUploadClick: () -> Unit,
    onUploadFolderClick: (FolderEntity?) -> Unit,
    onCreateFolderClick: (String) -> Unit,
    onFolderClick: (FolderEntity) -> Unit,
    onNavigateBackFolder: () -> Unit,
    onFileClick: (FileEntity) -> Unit,
    onDownloadFile: (FileEntity) -> Unit,
    onRetryUpload: (FileEntity) -> Unit,
    onStarClick: (FileEntity) -> Unit,
    onTrashClick: (FileEntity) -> Unit,
    onRestoreClick: (FileEntity) -> Unit,
    onDeletePermanentlyClick: (FileEntity) -> Unit,
    onOpenTransfers: () -> Unit,
    onOpenBackupSettings: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenDecryptTool: () -> Unit,
    onRefresh: () -> Unit,
    onRenameFile: (FileEntity, newName: String) -> Unit,
    onMoveFile: (FileEntity, targetFolderId: String?) -> Unit,
    onRenameFolder: (FolderEntity, newName: String) -> Unit,
    onMoveFolder: (FolderEntity, targetParentId: String?) -> Unit,
    onDeleteFolder: (FolderEntity) -> Unit
) {
    val context = LocalContext.current
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val coroutineScope = rememberCoroutineScope()

    val networkObserver = remember { NetworkObserver(context) }
    val isConnected by networkObserver.isConnected.collectAsState(initial = true)

    var selectedTab by remember { mutableStateOf(HomeTab.HOME) }
    var showCreateFolderDialog by remember { mutableStateOf(false) }
    var showExitDialog by remember { mutableStateOf(false) }
    var showFabMenu by remember { mutableStateOf(false) }
    var newFolderName by remember { mutableStateOf("") }

    var renameTargetFile by remember { mutableStateOf<FileEntity?>(null) }
    var renameTargetFolder by remember { mutableStateOf<FolderEntity?>(null) }
    var moveTargetFile by remember { mutableStateOf<FileEntity?>(null) }
    var moveTargetFolder by remember { mutableStateOf<FolderEntity?>(null) }
    var renameInputText by remember { mutableStateOf("") }

    val pullToRefreshState = rememberPullToRefreshState()
    if (pullToRefreshState.isRefreshing) {
        LaunchedEffect(true) {
            onRefresh()
            delay(800)
            pullToRefreshState.endRefresh()
        }
    }

    // Flawless Back Handler
    BackHandler(enabled = true) {
        if (selectedFileIds.isNotEmpty()) {
            onClearSelection()
        } else if (currentFolderId != null) {
            onNavigateBackFolder()
        } else if (selectedTab != HomeTab.HOME) {
            selectedTab = HomeTab.HOME
        } else {
            showExitDialog = true
        }
    }

    val filteredFiles = when (selectedTab) {
        HomeTab.HOME -> files.filter { !it.isTrashed }
        HomeTab.STARRED -> files.filter { it.isStarred && !it.isTrashed }
        HomeTab.FOLDERS -> files.filter { !it.isTrashed }
        HomeTab.TRASH -> trashedFiles
    }

    val totalSizeBytes = files.filter { !it.isTrashed }.sumOf { it.size }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet(
                modifier = Modifier.width(300.dp)
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(20.dp)
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Image(
                            painter = painterResource(id = R.drawable.ic_teledrive_logo),
                            contentDescription = "TeleDrive Logo",
                            modifier = Modifier.size(36.dp)
                        )
                        Spacer(modifier = Modifier.width(12.dp))
                        Text("TeleDrive Cloud", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
                    }

                    Spacer(modifier = Modifier.height(20.dp))
                    HorizontalDivider()
                    Spacer(modifier = Modifier.height(12.dp))

                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.AccessTime, contentDescription = null) },
                        label = { Text("Recent") },
                        selected = selectedTab == HomeTab.HOME,
                        onClick = {
                            selectedTab = HomeTab.HOME
                            coroutineScope.launch { drawerState.close() }
                        }
                    )
                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.CloudUpload, contentDescription = null) },
                        label = { Text("Active Transfers") },
                        selected = false,
                        onClick = {
                            coroutineScope.launch { drawerState.close() }
                            onOpenTransfers()
                        }
                    )
                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.Delete, contentDescription = null) },
                        label = { Text("Trash") },
                        selected = selectedTab == HomeTab.TRASH,
                        onClick = {
                            selectedTab = HomeTab.TRASH
                            coroutineScope.launch { drawerState.close() }
                        }
                    )

                    Spacer(modifier = Modifier.height(8.dp))
                    HorizontalDivider()
                    Spacer(modifier = Modifier.height(8.dp))

                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.Backup, contentDescription = null) },
                        label = { Text("Auto-Backup") },
                        selected = false,
                        onClick = {
                            coroutineScope.launch { drawerState.close() }
                            onOpenBackupSettings()
                        }
                    )
                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.LockOpen, contentDescription = null) },
                        label = { Text("Decrypt External File") },
                        selected = false,
                        onClick = {
                            coroutineScope.launch { drawerState.close() }
                            onOpenDecryptTool()
                        }
                    )
                    NavigationDrawerItem(
                        icon = { Icon(Icons.Default.Settings, contentDescription = null) },
                        label = { Text("Settings") },
                        selected = false,
                        onClick = {
                            coroutineScope.launch { drawerState.close() }
                            onOpenSettings()
                        }
                    )

                    Spacer(modifier = Modifier.height(8.dp))
                    HorizontalDivider()
                    Spacer(modifier = Modifier.height(16.dp))

                    Card(
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Default.CloudQueue, contentDescription = null, modifier = Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
                                Spacer(modifier = Modifier.width(8.dp))
                                Text("Storage Used", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                            }
                            Spacer(modifier = Modifier.height(6.dp))
                            LinearProgressIndicator(
                                progress = { ((totalSizeBytes / (1024f * 1024f)) / 1000f).coerceIn(0.01f, 1f) },
                                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp))
                            )
                            Spacer(modifier = Modifier.height(6.dp))
                            Text(
                                "${formatFileSize(totalSizeBytes)} of Unlimited used",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
            }
        }
    ) {
        Scaffold(
            topBar = {
                if (selectedFileIds.isNotEmpty()) {
                    // Multi-Select Contextual Top Action Bar
                    Surface(
                        color = MaterialTheme.colorScheme.primaryContainer,
                        tonalElevation = 4.dp,
                        modifier = Modifier.fillMaxWidth().height(60.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                IconButton(onClick = onClearSelection) {
                                    Icon(Icons.Default.Close, contentDescription = "Clear Selection")
                                }
                                Spacer(modifier = Modifier.width(8.dp))
                                Text("${selectedFileIds.size} Selected", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                            }
                            Row {
                                IconButton(onClick = onBatchDownload) {
                                    Icon(Icons.Default.FileDownload, contentDescription = "Download Selected")
                                }
                                IconButton(onClick = onBatchStar) {
                                    Icon(Icons.Default.Star, contentDescription = "Star Selected")
                                }
                                IconButton(onClick = onBatchDelete) {
                                    Icon(Icons.Default.Delete, contentDescription = "Delete Selected")
                                }
                            }
                        }
                    }
                } else {
                    Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                        // Modern Material 3 Pill Search Bar
                        Surface(
                            shape = RoundedCornerShape(28.dp),
                            color = MaterialTheme.colorScheme.surfaceVariant,
                            tonalElevation = 2.dp,
                            modifier = Modifier.fillMaxWidth().height(52.dp)
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxSize()
                                    .padding(horizontal = 8.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                if (currentFolderId != null) {
                                    IconButton(onClick = onNavigateBackFolder) {
                                        Icon(Icons.Default.ArrowBack, contentDescription = "Back Folder", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                } else {
                                    IconButton(onClick = { coroutineScope.launch { drawerState.open() } }) {
                                        Icon(Icons.Default.Menu, contentDescription = "Menu", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                }
                                Spacer(modifier = Modifier.width(4.dp))
                                OutlinedTextField(
                                    value = searchQuery,
                                    onValueChange = onSearchQueryChange,
                                    placeholder = { Text("Search in Drive", style = MaterialTheme.typography.bodyLarge) },
                                    modifier = Modifier.weight(1f),
                                    singleLine = true,
                                    colors = OutlinedTextFieldDefaults.colors(
                                        focusedBorderColor = Color.Transparent,
                                        unfocusedBorderColor = Color.Transparent
                                    )
                                )
                                IconButton(onClick = onToggleViewMode) {
                                    Icon(
                                        imageVector = if (isGridView) Icons.Default.ViewList else Icons.Default.GridView,
                                        contentDescription = "Toggle View",
                                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                                Surface(
                                    shape = CircleShape,
                                    color = if (isConnected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.errorContainer,
                                    modifier = Modifier.size(32.dp)
                                ) {
                                    Box(contentAlignment = Alignment.Center) {
                                        Image(
                                            painter = painterResource(id = R.drawable.ic_teledrive_logo),
                                            contentDescription = "Bot Connected Status",
                                            modifier = Modifier.size(20.dp)
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            },
            bottomBar = {
                // Google Drive Style Navigation Bar
                NavigationBar {
                    HomeTab.entries.forEach { tab ->
                        NavigationBarItem(
                            selected = selectedTab == tab,
                            onClick = { selectedTab = tab },
                            icon = { Icon(tab.icon, contentDescription = tab.label) },
                            label = { Text(tab.label) }
                        )
                    }
                }
            },
            floatingActionButton = {
                ExtendedFloatingActionButton(
                    onClick = { showFabMenu = true },
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                    icon = { Icon(Icons.Default.Add, contentDescription = null) },
                    text = { Text("New") }
                )
            }
        ) { padding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .nestedScroll(pullToRefreshState.nestedScrollConnection)
            ) {
                Column(
                    modifier = Modifier.fillMaxSize()
                ) {
                    // Offline Network Warning Banner
                    if (!isConnected) {
                        Card(
                            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 4.dp)
                        ) {
                            Row(
                                modifier = Modifier.padding(12.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Icon(Icons.Default.WifiOff, contentDescription = null, tint = MaterialTheme.colorScheme.onErrorContainer)
                                Spacer(modifier = Modifier.width(10.dp))
                                Text(
                                    "No Internet Connection! Connect to Wi-Fi or Mobile Data to upload.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onErrorContainer,
                                    fontWeight = FontWeight.SemiBold
                                )
                            }
                        }
                    }

                    // Sleek Live Floating Upload Progress Card
                    if (uploadState.isUploading) {
                        Card(
                            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer),
                            shape = RoundedCornerShape(16.dp),
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 6.dp)
                        ) {
                            Column(modifier = Modifier.padding(12.dp)) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        text = "Uploading: ${uploadState.fileName}",
                                        style = MaterialTheme.typography.titleSmall,
                                        fontWeight = FontWeight.SemiBold,
                                        maxLines = 1,
                                        modifier = Modifier.weight(1f)
                                    )
                                    Text(
                                        text = "${(uploadState.progressPercentage * 100).toInt()}%",
                                        style = MaterialTheme.typography.titleSmall,
                                        color = MaterialTheme.colorScheme.primary,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                                Spacer(modifier = Modifier.height(6.dp))
                                LinearProgressIndicator(
                                    progress = { uploadState.progressPercentage },
                                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp))
                                )
                                Spacer(modifier = Modifier.height(6.dp))
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Text(
                                        text = "Speed: ${uploadState.speedFormatted} | ETA: ${uploadState.etaFormatted}",
                                        style = MaterialTheme.typography.bodySmall
                                    )
                                    Text(
                                        text = "${uploadState.bytesTransferredFormatted} / ${uploadState.totalBytesFormatted}",
                                        style = MaterialTheme.typography.bodySmall
                                    )
                                }
                            }
                        }
                    }

                    // Category Filter Chips
                    if (selectedTab == HomeTab.HOME || selectedTab == HomeTab.FOLDERS) {
                        LazyRow(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 4.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            items(FileCategory.entries.toTypedArray()) { category ->
                                FilterChip(
                                    selected = selectedCategory == category,
                                    onClick = { onCategorySelect(category) },
                                    label = { Text(category.label) }
                                )
                            }
                        }
                    }

                    // Folders Section (Minimalist Modern Google Drive Style Cards)
                    if ((selectedTab == HomeTab.HOME || selectedTab == HomeTab.FOLDERS) && folders.isNotEmpty()) {
                        Text(
                            text = "Folders",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)
                        )
                        LazyVerticalGrid(
                            columns = GridCells.Fixed(2),
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(max = 200.dp)
                                .padding(horizontal = 16.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp)
                        ) {
                            items(folders) { folder ->
                                var folderMenuExpanded by remember { mutableStateOf(false) }

                                Card(
                                    onClick = { onFolderClick(folder) },
                                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                                    shape = RoundedCornerShape(12.dp),
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(12.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.SpaceBetween
                                    ) {
                                        Row(
                                            verticalAlignment = Alignment.CenterVertically,
                                            modifier = Modifier.weight(1f)
                                        ) {
                                            Icon(
                                                imageVector = if (folder.isLocked) Icons.Default.Lock else Icons.Default.Folder,
                                                contentDescription = null,
                                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                                modifier = Modifier.size(24.dp)
                                            )
                                            Spacer(modifier = Modifier.width(8.dp))
                                            Text(folder.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1)
                                        }
                                        Box {
                                            IconButton(
                                                onClick = { folderMenuExpanded = true },
                                                modifier = Modifier.size(24.dp)
                                            ) {
                                                Icon(Icons.Default.MoreHoriz, contentDescription = "More", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                            }
                                            DropdownMenu(
                                                expanded = folderMenuExpanded,
                                                onDismissRequest = { folderMenuExpanded = false }
                                            ) {
                                                DropdownMenuItem(
                                                    text = { Text("Rename Folder") },
                                                    leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                                                    onClick = {
                                                        folderMenuExpanded = false
                                                        renameTargetFolder = folder
                                                        renameInputText = folder.name
                                                    }
                                                )
                                                DropdownMenuItem(
                                                    text = { Text("Move Folder") },
                                                    leadingIcon = { Icon(Icons.Default.DriveFileMove, contentDescription = null) },
                                                    onClick = {
                                                        folderMenuExpanded = false
                                                        moveTargetFolder = folder
                                                    }
                                                )
                                                DropdownMenuItem(
                                                    text = { Text("Delete Folder") },
                                                    leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null) },
                                                    onClick = {
                                                        folderMenuExpanded = false
                                                        onDeleteFolder(folder)
                                                    }
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Files Section Header
                    val headerText = if (selectedTab == HomeTab.HOME) {
                        "Files (${filteredFiles.size})"
                    } else {
                        "${selectedTab.label} (${filteredFiles.size})"
                    }

                    Text(
                        text = headerText,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)
                    )

                    if (filteredFiles.isEmpty()) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(32.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = "No files in ${selectedTab.label.lowercase()}. Tap '+' to upload.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    } else if (isGridView) {
                        LazyVerticalGrid(
                            columns = GridCells.Fixed(2),
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(horizontal = 16.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp)
                        ) {
                            items(filteredFiles) { file ->
                                FileGridItem(
                                    file = file,
                                    isSelected = selectedFileIds.contains(file.id),
                                    isTrashTab = selectedTab == HomeTab.TRASH,
                                    onFileClick = onFileClick,
                                    onToggleSelection = { onToggleFileSelection(file.id) },
                                    onDownloadFile = onDownloadFile,
                                    onRetryUpload = onRetryUpload,
                                    onStarClick = onStarClick,
                                    onTrashClick = onTrashClick,
                                    onRestoreClick = onRestoreClick,
                                    onDeletePermanentlyClick = onDeletePermanentlyClick,
                                    onRenameClick = {
                                        renameTargetFile = file
                                        renameInputText = file.name
                                    },
                                    onMoveClick = {
                                        moveTargetFile = file
                                    }
                                )
                            }
                        }
                    } else {
                        LazyColumn(
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(horizontal = 16.dp)
                        ) {
                            items(filteredFiles) { file ->
                                FileListItem(
                                    file = file,
                                    isSelected = selectedFileIds.contains(file.id),
                                    isTrashTab = selectedTab == HomeTab.TRASH,
                                    onFileClick = onFileClick,
                                    onToggleSelection = { onToggleFileSelection(file.id) },
                                    onDownloadFile = onDownloadFile,
                                    onRetryUpload = onRetryUpload,
                                    onStarClick = onStarClick,
                                    onTrashClick = onTrashClick,
                                    onRestoreClick = onRestoreClick,
                                    onDeletePermanentlyClick = onDeletePermanentlyClick,
                                    onRenameClick = {
                                        renameTargetFile = file
                                        renameInputText = file.name
                                    },
                                    onMoveClick = {
                                        moveTargetFile = file
                                    }
                                )
                            }
                        }
                    }
                }

                // Hide Spinner when idle
                if (pullToRefreshState.isRefreshing) {
                    PullToRefreshContainer(
                        state = pullToRefreshState,
                        modifier = Modifier.align(Alignment.TopCenter)
                    )
                }
            }
        }
    }

    // Floating Action Menu Modal Bottom Sheet
    if (showFabMenu) {
        ModalBottomSheet(onDismissRequest = { showFabMenu = false }) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(24.dp)
            ) {
                Text("Create New", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(16.dp))

                ListItem(
                    headlineContent = { Text("Create Folder") },
                    leadingContent = { Icon(Icons.Default.CreateNewFolder, contentDescription = null) },
                    modifier = Modifier.combinedClickable {
                        showFabMenu = false
                        showCreateFolderDialog = true
                    }
                )
                ListItem(
                    headlineContent = { Text("Upload File") },
                    leadingContent = { Icon(Icons.Default.FileUpload, contentDescription = null) },
                    modifier = Modifier.combinedClickable(enabled = isConnected) {
                        showFabMenu = false
                        if (isConnected) onUploadClick()
                    }
                )
                ListItem(
                    headlineContent = { Text("Upload Folder") },
                    leadingContent = { Icon(Icons.Default.DriveFolderUpload, contentDescription = null) },
                    modifier = Modifier.combinedClickable(enabled = isConnected) {
                        showFabMenu = false
                        if (isConnected) onUploadFolderClick(null)
                    }
                )
                ListItem(
                    headlineContent = { Text("Camera Auto-Backup") },
                    leadingContent = { Icon(Icons.Default.PhotoCamera, contentDescription = null) },
                    modifier = Modifier.combinedClickable {
                        showFabMenu = false
                        onOpenBackupSettings()
                    }
                )
            }
        }
    }

    // Rename File/Folder Dialog
    if (renameTargetFile != null || renameTargetFolder != null) {
        AlertDialog(
            onDismissRequest = {
                renameTargetFile = null
                renameTargetFolder = null
            },
            title = { Text(if (renameTargetFile != null) "Rename File" else "Rename Folder") },
            text = {
                OutlinedTextField(
                    value = renameInputText,
                    onValueChange = { renameInputText = it },
                    label = { Text("New Name") },
                    singleLine = true
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (renameInputText.isNotBlank()) {
                            renameTargetFile?.let { onRenameFile(it, renameInputText) }
                            renameTargetFolder?.let { onRenameFolder(it, renameInputText) }
                            renameTargetFile = null
                            renameTargetFolder = null
                        }
                    }
                ) {
                    Text("Rename")
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        renameTargetFile = null
                        renameTargetFolder = null
                    }
                ) {
                    Text("Cancel")
                }
            }
        )
    }

    // Move File to Folder Dialog
    moveTargetFile?.let { targetFile ->
        AlertDialog(
            onDismissRequest = { moveTargetFile = null },
            title = { Text("Move File: ${targetFile.name}") },
            text = {
                Column(modifier = Modifier.fillMaxWidth()) {
                    Text("Select Destination Folder:", style = MaterialTheme.typography.bodySmall)
                    Spacer(modifier = Modifier.height(8.dp))

                    ListItem(
                        headlineContent = { Text("My Drive (Root)") },
                        leadingContent = { Icon(Icons.Default.Home, contentDescription = null) },
                        modifier = Modifier.combinedClickable {
                            onMoveFile(targetFile, null)
                            moveTargetFile = null
                        }
                    )
                    HorizontalDivider()

                    folders.forEach { folder ->
                        ListItem(
                            headlineContent = { Text(folder.name) },
                            leadingContent = { Icon(Icons.Default.Folder, contentDescription = null) },
                            modifier = Modifier.combinedClickable {
                                onMoveFile(targetFile, folder.id)
                                moveTargetFile = null
                            }
                        )
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { moveTargetFile = null }) {
                    Text("Cancel")
                }
            }
        )
    }

    // Move Folder Dialog
    moveTargetFolder?.let { targetFolder ->
        AlertDialog(
            onDismissRequest = { moveTargetFolder = null },
            title = { Text("Move Folder: ${targetFolder.name}") },
            text = {
                Column(modifier = Modifier.fillMaxWidth()) {
                    Text("Select Parent Destination Folder:", style = MaterialTheme.typography.bodySmall)
                    Spacer(modifier = Modifier.height(8.dp))

                    ListItem(
                        headlineContent = { Text("My Drive (Root)") },
                        leadingContent = { Icon(Icons.Default.Home, contentDescription = null) },
                        modifier = Modifier.combinedClickable {
                            onMoveFolder(targetFolder, null)
                            moveTargetFolder = null
                        }
                    )
                    HorizontalDivider()

                    folders.filter { it.id != targetFolder.id }.forEach { folder ->
                        ListItem(
                            headlineContent = { Text(folder.name) },
                            leadingContent = { Icon(Icons.Default.Folder, contentDescription = null) },
                            modifier = Modifier.combinedClickable {
                                onMoveFolder(targetFolder, folder.id)
                                moveTargetFolder = null
                            }
                        )
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { moveTargetFolder = null }) {
                    Text("Cancel")
                }
            }
        )
    }

    if (showCreateFolderDialog) {
        AlertDialog(
            onDismissRequest = { showCreateFolderDialog = false },
            title = { Text("Create New Folder") },
            text = {
                OutlinedTextField(
                    value = newFolderName,
                    onValueChange = { newFolderName = it },
                    label = { Text("Folder Name") },
                    singleLine = true
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (newFolderName.isNotBlank()) {
                            onCreateFolderClick(newFolderName)
                            newFolderName = ""
                            showCreateFolderDialog = false
                        }
                    }
                ) {
                    Text("Create")
                }
            },
            dismissButton = {
                TextButton(onClick = { showCreateFolderDialog = false }) {
                    Text("Cancel")
                }
            }
        )
    }

    // App Exit Confirmation Dialog
    if (showExitDialog) {
        AlertDialog(
            onDismissRequest = { showExitDialog = false },
            title = { Text("Exit TeleDrive?") },
            text = { Text("Are you sure you want to exit TeleDrive?") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showExitDialog = false
                        (context as? Activity)?.finish()
                    }
                ) {
                    Text("Yes, Exit")
                }
            },
            dismissButton = {
                TextButton(onClick = { showExitDialog = false }) {
                    Text("No, Cancel")
                }
            }
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun FileListItem(
    file: FileEntity,
    isSelected: Boolean = false,
    isTrashTab: Boolean,
    onFileClick: (FileEntity) -> Unit,
    onToggleSelection: () -> Unit = {},
    onDownloadFile: (FileEntity) -> Unit,
    onRetryUpload: (FileEntity) -> Unit,
    onStarClick: (FileEntity) -> Unit,
    onTrashClick: (FileEntity) -> Unit,
    onRestoreClick: (FileEntity) -> Unit,
    onDeletePermanentlyClick: (FileEntity) -> Unit,
    onRenameClick: (FileEntity) -> Unit,
    onMoveClick: (FileEntity) -> Unit
) {
    val context = LocalContext.current
    var menuExpanded by remember { mutableStateOf(false) }
    val (icon, tint) = getCategoryIconAndColor(file.mimeType, file.name)
    val cachedPreviewFile = remember(file.id) { File(context.cacheDir, "teledrive_cache/${file.id}") }

    ListItem(
        headlineContent = { Text(file.name, fontWeight = FontWeight.Medium, maxLines = 1) },
        supportingContent = { Text(formatFileSize(file.size)) },
        leadingContent = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (isSelected) {
                    Icon(Icons.Default.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(24.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                }
                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = tint.copy(alpha = 0.15f),
                    modifier = Modifier.size(40.dp)
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        if ((file.mimeType.startsWith("image/") || file.mimeType.startsWith("video/")) && cachedPreviewFile.exists()) {
                            AsyncImage(
                                model = cachedPreviewFile,
                                contentDescription = file.name,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier.fillMaxSize()
                            )
                        } else {
                            Icon(imageVector = icon, contentDescription = null, tint = tint, modifier = Modifier.size(24.dp))
                        }
                    }
                }
            }
        },
        trailingContent = {
            Box {
                IconButton(onClick = { menuExpanded = true }) {
                    Icon(Icons.Default.MoreVert, contentDescription = "More")
                }
                DropdownMenu(
                    expanded = menuExpanded,
                    onDismissRequest = { menuExpanded = false }
                ) {
                    if (isTrashTab) {
                        DropdownMenuItem(
                            text = { Text("Restore File") },
                            leadingIcon = { Icon(Icons.Default.Restore, contentDescription = null) },
                            onClick = {
                                menuExpanded = false
                                onRestoreClick(file)
                            }
                        )
                        DropdownMenuItem(
                            text = { Text("Delete Permanently") },
                            leadingIcon = { Icon(Icons.Default.DeleteForever, contentDescription = null) },
                            onClick = {
                                menuExpanded = false
                                onDeletePermanentlyClick(file)
                            }
                        )
                    } else {
                        DropdownMenuItem(
                            text = { Text("Open / Preview") },
                            leadingIcon = { Icon(Icons.Default.Visibility, contentDescription = null) },
                            onClick = {
                                menuExpanded = false
                                onFileClick(file)
                            }
                        )
                        
                        if (file.telegramFileId.startsWith("local_")) {
                            DropdownMenuItem(
                                text = { Text("Retry Upload to Cloud", color = MaterialTheme.colorScheme.error) },
                                leadingIcon = { Icon(Icons.Default.CloudUpload, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                                onClick = {
                                    menuExpanded = false
                                    onRetryUpload(file)
                                }
                            )
                        } else {
                            DropdownMenuItem(
                                text = { Text("Download to Phone") },
                                leadingIcon = { Icon(Icons.Default.FileDownload, contentDescription = null) },
                                onClick = {
                                    menuExpanded = false
                                    onDownloadFile(file)
                                }
                            )
                        }
                        
                        DropdownMenuItem(
                            text = { Text("Rename") },
                            leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                            onClick = {
                                menuExpanded = false
                                onRenameClick(file)
                            }
                        )
                        DropdownMenuItem(
                            text = { Text("Move to Folder") },
                            leadingIcon = { Icon(Icons.Default.DriveFileMove, contentDescription = null) },
                            onClick = {
                                menuExpanded = false
                                onMoveClick(file)
                            }
                        )
                        DropdownMenuItem(
                            text = { Text(if (file.isStarred) "Unstar" else "Star") },
                            leadingIcon = { Icon(if (file.isStarred) Icons.Default.Star else Icons.Default.StarBorder, contentDescription = null) },
                            onClick = {
                                menuExpanded = false
                                onStarClick(file)
                            }
                        )
                        DropdownMenuItem(
                            text = { Text("Move to Trash") },
                            leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null) },
                            onClick = {
                                menuExpanded = false
                                onTrashClick(file)
                            }
                        )
                    }
                }
            }
        },
        modifier = Modifier.combinedClickable(
            onClick = { onFileClick(file) },
            onLongClick = onToggleSelection
        )
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun FileGridItem(
    file: FileEntity,
    isSelected: Boolean = false,
    isTrashTab: Boolean,
    onFileClick: (FileEntity) -> Unit,
    onToggleSelection: () -> Unit = {},
    onDownloadFile: (FileEntity) -> Unit,
    onRetryUpload: (FileEntity) -> Unit,
    onStarClick: (FileEntity) -> Unit,
    onTrashClick: (FileEntity) -> Unit,
    onRestoreClick: (FileEntity) -> Unit,
    onDeletePermanentlyClick: (FileEntity) -> Unit,
    onRenameClick: (FileEntity) -> Unit,
    onMoveClick: (FileEntity) -> Unit
) {
    val context = LocalContext.current
    var menuExpanded by remember { mutableStateOf(false) }
    val (icon, tint) = getCategoryIconAndColor(file.mimeType, file.name)
    val cachedPreviewFile = remember(file.id) { File(context.cacheDir, "teledrive_cache/${file.id}") }
    val isMedia = file.mimeType.startsWith("image/") || file.mimeType.startsWith("video/")

    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (isSelected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant
        ),
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier
            .fillMaxWidth()
            .height(200.dp)
            .combinedClickable(
                onClick = { onFileClick(file) },
                onLongClick = onToggleSelection
            )
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            // Large Thumbnail Section
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .background(MaterialTheme.colorScheme.surfaceVariant)
            ) {
                if (isMedia && cachedPreviewFile.exists()) {
                    AsyncImage(
                        model = cachedPreviewFile,
                        contentDescription = file.name,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize()
                    )
                    if (file.mimeType.startsWith("video/")) {
                        Surface(
                            shape = CircleShape,
                            color = Color.Black.copy(alpha = 0.6f),
                            modifier = Modifier
                                .align(Alignment.BottomEnd)
                                .padding(8.dp)
                                .size(32.dp)
                        ) {
                            Box(contentAlignment = Alignment.Center) {
                                Icon(Icons.Default.PlayArrow, contentDescription = "Play Video", tint = Color.White, modifier = Modifier.size(20.dp))
                            }
                        }
                    }
                } else {
                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Icon(imageVector = icon, contentDescription = null, tint = tint.copy(alpha = 0.5f), modifier = Modifier.size(48.dp))
                    }
                }

                // Top-Left Selection Indicator overlaid on thumbnail
                Box(
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .padding(8.dp)
                ) {
                    if (isSelected) {
                        Surface(
                            shape = CircleShape,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(24.dp)
                        ) {
                            Icon(Icons.Default.Check, contentDescription = "Selected", tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.padding(4.dp))
                        }
                    } else {
                        Surface(
                            shape = CircleShape,
                            color = Color.Black.copy(alpha = 0.4f),
                            modifier = Modifier.size(24.dp)
                        ) {}
                    }
                }
                
                // Top-Right Context Menu Overlaid
                Box(
                    modifier = Modifier.align(Alignment.TopEnd)
                ) {
                    IconButton(onClick = { menuExpanded = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "More", tint = Color.White)
                    }
                    DropdownMenu(
                        expanded = menuExpanded,
                        onDismissRequest = { menuExpanded = false }
                    ) {
                        if (isTrashTab) {
                            DropdownMenuItem(
                                text = { Text("Restore File") },
                                leadingIcon = { Icon(Icons.Default.Restore, contentDescription = null) },
                                onClick = {
                                    menuExpanded = false
                                    onRestoreClick(file)
                                }
                            )
                            DropdownMenuItem(
                                text = { Text("Delete Permanently") },
                                leadingIcon = { Icon(Icons.Default.DeleteForever, contentDescription = null) },
                                onClick = {
                                    menuExpanded = false
                                    onDeletePermanentlyClick(file)
                                }
                            )
                        } else {
                            DropdownMenuItem(
                                text = { Text("Open / Preview") },
                                leadingIcon = { Icon(Icons.Default.Visibility, contentDescription = null) },
                                onClick = {
                                    menuExpanded = false
                                    onFileClick(file)
                                }
                            )
                            
                            if (file.telegramFileId.startsWith("local_")) {
                                DropdownMenuItem(
                                    text = { Text("Retry Upload to Cloud", color = MaterialTheme.colorScheme.error) },
                                    leadingIcon = { Icon(Icons.Default.CloudUpload, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                                    onClick = {
                                        menuExpanded = false
                                        onRetryUpload(file)
                                    }
                                )
                            } else {
                                DropdownMenuItem(
                                    text = { Text("Download to Phone") },
                                    leadingIcon = { Icon(Icons.Default.FileDownload, contentDescription = null) },
                                    onClick = {
                                        menuExpanded = false
                                        onDownloadFile(file)
                                    }
                                )
                            }
                            
                            DropdownMenuItem(
                                text = { Text("Rename") },
                                leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                                onClick = {
                                    menuExpanded = false
                                    onRenameClick(file)
                                }
                            )
                            DropdownMenuItem(
                                text = { Text("Move to Folder") },
                                leadingIcon = { Icon(Icons.Default.DriveFileMove, contentDescription = null) },
                                onClick = {
                                    menuExpanded = false
                                    onMoveClick(file)
                                }
                            )
                            DropdownMenuItem(
                                text = { Text(if (file.isStarred) "Unstar" else "Star") },
                                leadingIcon = { Icon(if (file.isStarred) Icons.Default.Star else Icons.Default.StarBorder, contentDescription = null) },
                                onClick = {
                                    menuExpanded = false
                                    onStarClick(file)
                                }
                            )
                            DropdownMenuItem(
                                text = { Text("Move to Trash") },
                                leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null) },
                                onClick = {
                                    menuExpanded = false
                                    onTrashClick(file)
                                }
                            )
                        }
                    }
                }
            }

            // Bottom Metadata Area
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        Brush.verticalGradient(
                            colors = listOf(Color(0xFF2A2B2E), Color(0xFF1E1F22))
                        )
                    )
                    .padding(horizontal = 12.dp, vertical = 10.dp)
            ) {
                Column {
                    Text(
                        text = file.name,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold,
                        color = Color.White,
                        maxLines = 1
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = formatFileSize(file.size),
                            style = MaterialTheme.typography.bodySmall,
                            color = Color(0xFFAAAAAA)
                        )
                        Text(
                            text = formatDate(file.createdAt),
                            style = MaterialTheme.typography.bodySmall,
                            color = Color(0xFFAAAAAA)
                        )
                    }
                }
            }
        }
    }
}

private fun getCategoryIconAndColor(mimeType: String, fileName: String): Pair<ImageVector, Color> {
    return when {
        mimeType.startsWith("image/") -> Pair(Icons.Default.Image, Color(0xFF8E24AA)) // Purple
        mimeType.startsWith("video/") -> Pair(Icons.Default.Movie, Color(0xFFE53935)) // Red
        mimeType.startsWith("audio/") -> Pair(Icons.Default.MusicNote, Color(0xFF43A047)) // Green
        mimeType == "application/pdf" -> Pair(Icons.Default.PictureAsPdf, Color(0xFF1E88E5)) // Blue
        fileName.endsWith(".zip") || fileName.endsWith(".rar") -> Pair(Icons.Default.FolderZip, Color(0xFFFB8C00)) // Amber
        else -> Pair(Icons.Default.InsertDriveFile, Color(0xFF5C6BC0)) // Slate Blue
    }
}
