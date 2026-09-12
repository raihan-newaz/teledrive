package com.example.teledrive.utils

import javax.crypto.spec.SecretKeySpec
import javax.inject.Singleton

@Singleton
object SessionManager {
    var masterKey: SecretKeySpec? = null
    var apiId: String? = null
    var apiHash: String? = null
    var botToken: String? = null
    var chatId: String? = null
}
