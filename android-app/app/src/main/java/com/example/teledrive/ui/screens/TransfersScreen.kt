package com.example.teledrive.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.teledrive.utils.TransferManager
import com.example.teledrive.utils.TransferState
import com.example.teledrive.utils.UploadTask

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TransfersScreen(
    transferManager: TransferManager,
    onBack: () -> Unit
) {
    BackHandler { onBack() }

    val queue by transferManager.uploadQueue.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Active Transfers") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = { transferManager.clearCompletedAndFailed() }) {
                        Icon(Icons.Default.ClearAll, contentDescription = "Clear Finished")
                    }
                }
            )
        }
    ) { padding ->
        if (queue.isEmpty()) {
            Box(modifier = Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.CloudQueue, contentDescription = null, modifier = Modifier.size(64.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f))
                    Spacer(modifier = Modifier.height(16.dp))
                    Text("No active transfers", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                items(queue) { task ->
                    TransferTaskItem(task)
                }
            }
        }
    }
}

@Composable
fun TransferTaskItem(task: UploadTask) {
    val (statusColor, statusIcon, statusText) = when (task.state) {
        TransferState.PENDING -> Triple(MaterialTheme.colorScheme.onSurfaceVariant, Icons.Default.Schedule, "Pending in Queue")
        TransferState.UPLOADING -> Triple(MaterialTheme.colorScheme.primary, Icons.Default.CloudUpload, "Uploading...")
        TransferState.COMPLETED -> Triple(Color(0xFF43A047), Icons.Default.CheckCircle, "Completed")
        TransferState.FAILED -> Triple(MaterialTheme.colorScheme.error, Icons.Default.Error, "Failed: ${task.errorMessage}")
    }

    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = task.fileName,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    modifier = Modifier.weight(1f)
                )
                Icon(imageVector = statusIcon, contentDescription = null, tint = statusColor, modifier = Modifier.size(20.dp))
            }

            Spacer(modifier = Modifier.height(8.dp))

            if (task.state == TransferState.UPLOADING || task.state == TransferState.PENDING) {
                LinearProgressIndicator(
                    progress = { task.progressPercentage },
                    modifier = Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)),
                    color = statusColor
                )
            } else {
                Box(modifier = Modifier.fillMaxWidth().height(6.dp).background(statusColor.copy(alpha = 0.2f), RoundedCornerShape(3.dp))) {
                    Box(modifier = Modifier.fillMaxWidth(if (task.state == TransferState.COMPLETED) 1f else task.progressPercentage).height(6.dp).background(statusColor, RoundedCornerShape(3.dp)))
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = statusText,
                    style = MaterialTheme.typography.bodySmall,
                    color = statusColor,
                    fontWeight = FontWeight.SemiBold
                )
                if (task.state == TransferState.UPLOADING) {
                    Text(
                        text = "${formatFileSize(task.bytesTransferred)} / ${formatFileSize(task.fileSize)}  •  ${formatSpeed(task.speedBytesPerSec)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                } else if (task.state == TransferState.PENDING || task.state == TransferState.COMPLETED) {
                    Text(
                        text = formatFileSize(task.fileSize),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

private fun formatSpeed(bytesPerSec: Float): String {
    if (bytesPerSec < 1024) return String.format("%.0f B/s", bytesPerSec)
    val kbPerSec = bytesPerSec / 1024f
    if (kbPerSec < 1024) return String.format("%.1f KB/s", kbPerSec)
    val mbPerSec = kbPerSec / 1024f
    return String.format("%.1f MB/s", mbPerSec)
}
