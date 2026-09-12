package com.example.teledrive.webdav

import com.example.teledrive.data.local.FileDao
import com.example.teledrive.data.remote.TelegramStorageClient
import com.example.teledrive.utils.CryptoEngine
import com.example.teledrive.utils.SessionManager
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.cio.*
import io.ktor.server.engine.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.utils.io.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class LocalWebDavServer @Inject constructor(
    private val fileDao: FileDao,
    private val telegramStorageClient: TelegramStorageClient
) {
    private var server: ApplicationEngine? = null

    fun start() {
        if (server != null) return // Prevent BindException on Activity recreation

        server = embeddedServer(CIO, host = "127.0.0.1", port = 8080) {
            routing {
                get("/") {
                    call.respondText("TeleDrive Stream & WebDAV Server is running!", ContentType.Text.Plain)
                }

                // On-The-Fly Decryption Streaming Proxy
                get("/stream/{fileId}") {
                    val fileId = call.parameters["fileId"] ?: return@get call.respond(HttpStatusCode.BadRequest, "Missing fileId")

                    val fileEntity = withContext(Dispatchers.IO) { fileDao.getFileById(fileId) }
                        ?: return@get call.respond(HttpStatusCode.NotFound, "File not found")

                    if (fileEntity.telegramFileId.startsWith("local_")) {
                        return@get call.respond(HttpStatusCode.ServiceUnavailable, "File not uploaded to cloud yet")
                    }

                    val botToken = SessionManager.botToken ?: return@get call.respond(HttpStatusCode.Unauthorized, "No Token")
                    val masterKey = SessionManager.masterKey ?: return@get call.respond(HttpStatusCode.Unauthorized, "No Master Key")

                    val partEntries = fileEntity.telegramFileId.split(",")
                    val totalSize = fileEntity.size

                    val rangeHeader = call.request.header(HttpHeaders.Range)
                    var startByte = 0L
                    var endByte = totalSize - 1

                    if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
                        val ranges = rangeHeader.substringAfter("bytes=").split("-")
                        if (ranges[0].isNotEmpty()) startByte = ranges[0].toLong()
                        if (ranges.size > 1 && ranges[1].isNotEmpty()) endByte = ranges[1].toLong()
                    }

                    if (startByte >= totalSize) {
                        return@get call.respond(HttpStatusCode.RequestedRangeNotSatisfiable)
                    }

                    val contentLength = endByte - startByte + 1

                    call.response.header(HttpHeaders.AcceptRanges, "bytes")
                    call.response.header(HttpHeaders.ContentRange, "bytes $startByte-$endByte/$totalSize")
                    call.response.header(HttpHeaders.ContentType, fileEntity.mimeType)

                    val status = if (rangeHeader != null) HttpStatusCode.PartialContent else HttpStatusCode.OK

                    call.respondBytesWriter(status = status, contentLength = contentLength) {
                        var currentBytePos = 0L
                        val chunkSize = 19 * 1024 * 1024L // 19 MB per Telegram chunk

                        for (entry in partEntries) {
                            if (currentBytePos > endByte) break // Stop if we've passed the requested range
                            
                            val partEndPos = currentBytePos + chunkSize - 1

                            // Check if this part contains bytes within the requested [startByte, endByte] range
                            if (partEndPos >= startByte && currentBytePos <= endByte) {
                                val parts = entry.split(":")
                                val partId = parts[0].trim()
                                val partIv = if (parts.size > 1) CryptoEngine.fromBase64(parts[1].trim()) else CryptoEngine.fromBase64(fileEntity.iv)

                                try {
                                    val encryptedBytes = telegramStorageClient.downloadFileBytes(botToken, partId)
                                    val decryptedPart = CryptoEngine.decrypt(encryptedBytes, masterKey, partIv)

                                    val overlapStart = maxOf(0, (startByte - currentBytePos).toInt())
                                    val overlapEnd = minOf(decryptedPart.size - 1, (endByte - currentBytePos).toInt())
                                    
                                    if (overlapStart <= overlapEnd) {
                                        val slice = decryptedPart.sliceArray(overlapStart..overlapEnd)
                                        writeFully(slice)
                                        flush()
                                    }
                                } catch (e: Exception) {
                                    e.printStackTrace()
                                    break
                                }
                            }
                            currentBytePos += chunkSize
                        }
                    }
                }

                route("/{...}") {
                    handle {
                        if (call.request.local.method == HttpMethod("PROPFIND")) {
                            call.respond(HttpStatusCode.MultiStatus, "<?xml version=\"1.0\" encoding=\"utf-8\" ?><D:multistatus xmlns:D=\"DAV:\"></D:multistatus>")
                        } else {
                            call.respond(HttpStatusCode.NotImplemented)
                        }
                    }
                }
            }
        }.start(wait = false)
    }

    fun stop() {
        server?.stop(1000, 5000)
        server = null
    }
}
