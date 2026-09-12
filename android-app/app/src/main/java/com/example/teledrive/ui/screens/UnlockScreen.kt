package com.example.teledrive.ui.screens

import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.VpnKey
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.example.teledrive.R
import com.example.teledrive.utils.CryptoEngine
import com.example.teledrive.utils.SessionManager

@Composable
fun UnlockScreen(
    onUnlocked: () -> Unit
) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("teledrive_prefs", Context.MODE_PRIVATE) }
    var passwordInput by remember { mutableStateOf("") }
    val savedMasterPass = prefs.getString("master_pass", "default123") ?: "default123"
    val saltStr = prefs.getString("salt", null)

    fun attemptUnlock() {
        if (passwordInput.isNotBlank()) {
            if (passwordInput == savedMasterPass) {
                val salt = if (saltStr != null) CryptoEngine.fromBase64(saltStr) else CryptoEngine.generateSalt()
                SessionManager.masterKey = CryptoEngine.deriveKey(passwordInput.toCharArray(), salt)
                onUnlocked()
            } else {
                Toast.makeText(context, "Incorrect Master Password", Toast.LENGTH_SHORT).show()
            }
        }
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp)
                .imePadding(),
            contentAlignment = Alignment.Center
        ) {
            Card(
                shape = RoundedCornerShape(24.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier.padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Surface(
                        shape = CircleShape,
                        color = MaterialTheme.colorScheme.primaryContainer,
                        modifier = Modifier.size(64.dp)
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Image(
                                painter = painterResource(id = R.drawable.ic_teledrive_logo),
                                contentDescription = "TeleDrive Logo",
                                modifier = Modifier.size(36.dp)
                            )
                        }
                    }
                    Spacer(modifier = Modifier.height(16.dp))

                    Text("TeleDrive Secure", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        "Enter your Master Password to derive the AES-256-GCM session key.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )

                    Spacer(modifier = Modifier.height(24.dp))

                    OutlinedTextField(
                        value = passwordInput,
                        onValueChange = { passwordInput = it },
                        label = { Text("Master Password") },
                        leadingIcon = { Icon(Icons.Default.VpnKey, contentDescription = null) },
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(
                            onDone = { attemptUnlock() }
                        ),
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        shape = RoundedCornerShape(12.dp)
                    )

                    Spacer(modifier = Modifier.height(20.dp))

                    Button(
                        onClick = { attemptUnlock() },
                        modifier = Modifier.fillMaxWidth().height(48.dp),
                        enabled = passwordInput.isNotBlank(),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Text("Unlock Drive", fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}
