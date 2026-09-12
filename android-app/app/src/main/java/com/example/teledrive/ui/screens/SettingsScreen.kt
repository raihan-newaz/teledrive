package com.example.teledrive.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.example.teledrive.data.remote.ConnectionTestResult
import com.example.teledrive.utils.CryptoEngine
import com.example.teledrive.utils.SessionManager

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onTestConnection: (botToken: String, chatId: String, onResult: (ConnectionTestResult) -> Unit) -> Unit,
    onBackupDatabase: (onSuccess: () -> Unit, onError: (String) -> Unit) -> Unit,
    onRestoreDatabase: (onSuccess: () -> Unit, onError: (String) -> Unit) -> Unit
) {
    BackHandler { onBack() }

    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("teledrive_prefs", Context.MODE_PRIVATE) }

    var apiId by remember { mutableStateOf(prefs.getString("api_id", "") ?: "") }
    var apiHash by remember { mutableStateOf(prefs.getString("api_hash", "") ?: "") }
    var botToken by remember { mutableStateOf(prefs.getString("bot_token", "") ?: "") }
    var chatId by remember { mutableStateOf(prefs.getString("chat_id", "") ?: "") }
    var password by remember { mutableStateOf(prefs.getString("master_pass", "") ?: "") }

    var selectedChunkSize by remember { mutableStateOf(prefs.getString("chunk_size", "19.5 MB (Telegram Bot Limit)") ?: "19.5 MB (Telegram Bot Limit)") }
    var selectedParallelStreams by remember { mutableStateOf(prefs.getString("parallel_streams", "2x Streams (Recommended)") ?: "2x Streams (Recommended)") }

    var chunkSizeExpanded by remember { mutableStateOf(false) }
    var parallelStreamsExpanded by remember { mutableStateOf(false) }

    var isTestingConnection by remember { mutableStateOf(false) }
    var testResult by remember { mutableStateOf<ConnectionTestResult?>(null) }
    var isBackingUpDb by remember { mutableStateOf(false) }
    var isRestoringDb by remember { mutableStateOf(false) }

    val saltStr = prefs.getString("salt", "") ?: ""

    val chunkSizeOptions = listOf("19.5 MB (Telegram Bot Limit)", "10 MB", "15 MB")
    val parallelStreamOptions = listOf("1x Stream (Single)", "2x Streams (Recommended)", "3x Streams", "4x Streams")

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings & Credentials") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // App Appearance Theme Card
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.DarkMode, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("App Appearance & Theme", style = MaterialTheme.typography.titleMedium)
                    }
                    Spacer(modifier = Modifier.height(8.dp))

                    var themeExpanded by remember { mutableStateOf(false) }
                    var selectedTheme by remember { mutableStateOf(prefs.getString("theme_mode", "Follow System") ?: "Follow System") }
                    val themeOptions = listOf("Light Mode", "Dark Mode", "Follow System")

                    ExposedDropdownMenuBox(
                        expanded = themeExpanded,
                        onExpandedChange = { themeExpanded = !themeExpanded }
                    ) {
                        OutlinedTextField(
                            value = selectedTheme,
                            onValueChange = {},
                            readOnly = true,
                            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = themeExpanded) },
                            modifier = Modifier.menuAnchor().fillMaxWidth()
                        )
                        ExposedDropdownMenu(
                            expanded = themeExpanded,
                            onDismissRequest = { themeExpanded = false }
                        ) {
                            themeOptions.forEach { option ->
                                DropdownMenuItem(
                                    text = { Text(option) },
                                    onClick = {
                                        selectedTheme = option
                                        themeExpanded = false
                                        prefs.edit().putString("theme_mode", option).apply()
                                        Toast.makeText(context, "Theme set to $option", Toast.LENGTH_SHORT).show()
                                    }
                                )
                            }
                        }
                    }
                }
            }

            // Upload & Transfer Performance Card (Matches Web Interface)
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Speed, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Upload & Transfer Performance", style = MaterialTheme.typography.titleMedium)
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Configure multi-part chunking size and upload throughput for large files",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )

                    Spacer(modifier = Modifier.height(16.dp))

                    Text("Upload Chunk Size", style = MaterialTheme.typography.titleSmall)
                    Text("Telegram Bot API limits file downloads to max 20 MB per chunk", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(modifier = Modifier.height(6.dp))

                    ExposedDropdownMenuBox(
                        expanded = chunkSizeExpanded,
                        onExpandedChange = { chunkSizeExpanded = !chunkSizeExpanded }
                    ) {
                        OutlinedTextField(
                            value = selectedChunkSize,
                            onValueChange = {},
                            readOnly = true,
                            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = chunkSizeExpanded) },
                            modifier = Modifier.menuAnchor().fillMaxWidth()
                        )
                        ExposedDropdownMenu(
                            expanded = chunkSizeExpanded,
                            onDismissRequest = { chunkSizeExpanded = false }
                        ) {
                            chunkSizeOptions.forEach { option ->
                                DropdownMenuItem(
                                    text = { Text(option) },
                                    onClick = {
                                        selectedChunkSize = option
                                        chunkSizeExpanded = false
                                        prefs.edit().putString("chunk_size", option).apply()
                                    }
                                )
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(16.dp))

                    Text("Parallel Upload Streams", style = MaterialTheme.typography.titleSmall)
                    Text("Number of chunks uploaded simultaneously", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(modifier = Modifier.height(6.dp))

                    ExposedDropdownMenuBox(
                        expanded = parallelStreamsExpanded,
                        onExpandedChange = { parallelStreamsExpanded = !parallelStreamsExpanded }
                    ) {
                        OutlinedTextField(
                            value = selectedParallelStreams,
                            onValueChange = {},
                            readOnly = true,
                            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = parallelStreamsExpanded) },
                            modifier = Modifier.menuAnchor().fillMaxWidth()
                        )
                        ExposedDropdownMenu(
                            expanded = parallelStreamsExpanded,
                            onDismissRequest = { parallelStreamsExpanded = false }
                        ) {
                            parallelStreamOptions.forEach { option ->
                                DropdownMenuItem(
                                    text = { Text(option) },
                                    onClick = {
                                        selectedParallelStreams = option
                                        parallelStreamsExpanded = false
                                        prefs.edit().putString("parallel_streams", option).apply()
                                    }
                                )
                            }
                        }
                    }
                }
            }

            // Telegram Credentials Card
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Telegram Credentials", style = MaterialTheme.typography.titleMedium)
                    Spacer(modifier = Modifier.height(12.dp))

                    OutlinedTextField(
                        value = apiId,
                        onValueChange = { apiId = it },
                        label = { Text("API ID") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true
                    )
                    Spacer(modifier = Modifier.height(8.dp))

                    OutlinedTextField(
                        value = apiHash,
                        onValueChange = { apiHash = it },
                        label = { Text("API Hash") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true
                    )
                    Spacer(modifier = Modifier.height(8.dp))

                    OutlinedTextField(
                        value = botToken,
                        onValueChange = { botToken = it },
                        label = { Text("Bot Token") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true
                    )
                    Spacer(modifier = Modifier.height(8.dp))

                    OutlinedTextField(
                        value = chatId,
                        onValueChange = { chatId = it },
                        label = { Text("Storage Channel ID") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true
                    )
                    Spacer(modifier = Modifier.height(8.dp))

                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text("Master Password") },
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        OutlinedButton(
                            onClick = {
                                isTestingConnection = true
                                testResult = null
                                onTestConnection(botToken, chatId) { result ->
                                    testResult = result
                                    isTestingConnection = false
                                }
                            },
                            modifier = Modifier.weight(1f)
                        ) {
                            Text("Test")
                        }

                        Button(
                            onClick = {
                                SessionManager.apiId = apiId
                                SessionManager.apiHash = apiHash
                                SessionManager.botToken = botToken
                                SessionManager.chatId = chatId

                                val salt = if (saltStr.isNotBlank()) CryptoEngine.fromBase64(saltStr) else CryptoEngine.generateSalt()
                                SessionManager.masterKey = CryptoEngine.deriveKey(password.toCharArray(), salt)

                                prefs.edit().apply {
                                    putString("api_id", apiId)
                                    putString("api_hash", apiHash)
                                    putString("bot_token", botToken)
                                    putString("chat_id", chatId)
                                    putString("master_pass", password)
                                    putString("salt", CryptoEngine.toBase64(salt))
                                    apply()
                                }
                                Toast.makeText(context, "Credentials Saved!", Toast.LENGTH_SHORT).show()
                            },
                            modifier = Modifier.weight(1f)
                        ) {
                            Text("Save")
                        }
                    }

                    testResult?.let { res ->
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = if (res.success) "Connected: @${res.botUsername}" else "Error: ${res.errorMessage}",
                            color = if (res.success) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall
                        )
                    }
                }
            }

            // Export Encryption Key Note Keeping Card
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.VpnKey, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Export Master Key & Salt Note", style = MaterialTheme.typography.titleMedium)
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "Save this Master Key Note in your personal notes. If your device is lost, entering this key and salt in a new installation will decrypt all your Telegram cloud files.",
                        style = MaterialTheme.typography.bodySmall
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    Button(
                        onClick = {
                            val masterKeyBase64 = SessionManager.masterKey?.encoded?.let { CryptoEngine.toBase64(it) } ?: "Not Derived"
                            val note = "TeleDrive Recovery Note:\nMaster Password: $password\nSalt: $saltStr\nAES Key Base64: $masterKeyBase64\nBot Token: $botToken\nChannel ID: $chatId"
                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            val clip = ClipData.newPlainText("TeleDrive Encryption Note", note)
                            clipboard.setPrimaryClip(clip)
                            Toast.makeText(context, "Encryption Note Copied to Clipboard!", Toast.LENGTH_LONG).show()
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(Icons.Default.ContentCopy, contentDescription = null)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Copy Master Key Note to Clipboard")
                    }
                }
            }

            // Telegram Database Backup & Restore Card
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.CloudSync, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Telegram Database Backup & Restore", style = MaterialTheme.typography.titleMedium)
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "Backup your database metadata to your Telegram channel or restore metadata onto this device.",
                        style = MaterialTheme.typography.bodySmall
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Button(
                            onClick = {
                                isBackingUpDb = true
                                onBackupDatabase(
                                    {
                                        isBackingUpDb = false
                                        Toast.makeText(context, "Database backed up to Telegram!", Toast.LENGTH_SHORT).show()
                                    },
                                    { err ->
                                        isBackingUpDb = false
                                        Toast.makeText(context, "Backup Failed: $err", Toast.LENGTH_LONG).show()
                                    }
                                )
                            },
                            modifier = Modifier.weight(1f),
                            enabled = !isBackingUpDb
                        ) {
                            Text(if (isBackingUpDb) "Backing up..." else "Backup DB")
                        }

                        OutlinedButton(
                            onClick = {
                                isRestoringDb = true
                                onRestoreDatabase(
                                    {
                                        isRestoringDb = false
                                        Toast.makeText(context, "Database Restored! Reloading app...", Toast.LENGTH_LONG).show()
                                    },
                                    { err ->
                                        isRestoringDb = false
                                        Toast.makeText(context, "Restore Failed: $err", Toast.LENGTH_LONG).show()
                                    }
                                )
                            },
                            modifier = Modifier.weight(1f),
                            enabled = !isRestoringDb
                        ) {
                            Text(if (isRestoringDb) "Restoring..." else "Restore DB")
                        }
                    }
                }
            }
        }
    }
}
