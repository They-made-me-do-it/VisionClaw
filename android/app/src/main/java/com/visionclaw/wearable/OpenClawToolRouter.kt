// OpenClawToolRouter.kt
// VisionClaw
// Intercepts tool calls and routes them to the local OpenClaw Gateway on the LAN

package com.visionclaw.wearable

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.Response
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

public class OpenClawToolRouter private constructor() {
    companion object {
        public val shared: OpenClawToolRouter = OpenClawToolRouter()
    }

    private val httpClient = OkHttpClient()
    private val backgroundExecutor: ExecutorService = Executors.newFixedThreadPool(2)
    private val mainHandler = Handler(Looper.getMainLooper())

    public var gatewayIP: String = "192.168.1.100" // Example LAN IP
    public var gatewayPort: Int = 18789
    public var bearerToken: String = "oc_live_token_7a9c8b3d2e1f0"
    public var targetSandbox: Boolean = false

    private var eventWebSocket: WebSocket? = null

    @Volatile
    private var isUploadInFlight = false

    public interface ToolCallback {
        public fun onResponse(success: Boolean, result: String)
    }

    /**
     * Connects the OpenClaw event client earlier at the beginning of the session
     */
    public fun connectEventClient() {
        if (eventWebSocket != null) {
            System.out.println("[OpenClawToolRouter] Event client already connected or connecting.")
            return
        }

        val url = "ws://$gatewayIP:$gatewayPort/"
        System.out.println("[OpenClawToolRouter] Connecting event client to $url with localhost Host header bypass")

        val request = Request.Builder()
            .url(url)
            .header("Host", "localhost")
            .header("Authorization", "Bearer $bearerToken")
            .build()

        eventWebSocket = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                System.out.println("[OpenClawToolRouter] Event client WebSocket opened. Sending handshake...")
                sendHandshakeMessage(webSocket, null)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                System.out.println("[OpenClawToolRouter] Event client received message: $text")
                try {
                    val json = JSONObject(text)
                    val type = json.optString("type", "")
                    val eventName = json.optString("event", "")
                    
                    if (type == "event" && eventName == "connect.challenge") {
                        val data = json.optJSONObject("data")
                        val nonce = data?.optString("nonce")
                        System.out.println("[OpenClawToolRouter] Received challenge nonce: $nonce. Retrying handshake...")
                        sendHandshakeMessage(webSocket, nonce)
                    } else if (json.has("result") && json.optJSONObject("result")?.has("protocol") == true) {
                        System.out.println("[OpenClawToolRouter] Handshake successful: hello-ok received.")
                    }
                } catch (e: Exception) {
                    System.err.println("[OpenClawToolRouter] Event client parsing error: ${e.message}")
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (response != null && response.code == 500) {
                    // Suppress noisy 500 logs on non-essential status items
                    System.out.println("[OpenClawToolRouter] Suppressed event client WSS 500 Failure.")
                } else {
                    System.err.println("[OpenClawToolRouter] Event client WSS Failure: ${t.message}")
                }
                eventWebSocket = null
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                System.out.println("[OpenClawToolRouter] Event client WSS Closed: $reason ($code)")
                eventWebSocket = null
            }
        })
    }

    private fun sendHandshakeMessage(webSocket: WebSocket, nonce: String?) {
        try {
            val connectMsg = JSONObject()
            connectMsg.put("type", "req")
            connectMsg.put("id", "conn_${System.currentTimeMillis()}")
            connectMsg.put("method", "connect")
            
            val params = JSONObject()
            params.put("role", "operator")
            
            val scopes = org.json.JSONArray()
            scopes.put("operator.read")
            scopes.put("operator.write")
            scopes.put("operator.admin")
            params.put("scopes", scopes)
            
            val auth = JSONObject()
            auth.put("token", bearerToken)
            params.put("auth", auth)
            
            params.put("protocol", 3)
            if (nonce != null) {
                params.put("challenge", nonce)
            }
            
            val device = JSONObject()
            device.put("id", "visionclaw_android_edge")
            params.put("device", device)

            connectMsg.put("params", params)

            webSocket.send(connectMsg.toString())
            System.out.println("[OpenClawToolRouter] Handshake connection frame sent (Protocol v3 + operator.admin).")
        } catch (e: Exception) {
            System.err.println("[OpenClawToolRouter] Failed to build handshake message: ${e.message}")
        }
    }

    public fun disconnectEventClient() {
        eventWebSocket?.close(1000, "Session terminating")
        eventWebSocket = null
        System.out.println("[OpenClawToolRouter] Event client disconnected.")
    }

    /**
     * Entry point to route a JSON tool call intercept to OpenClaw
     */
    public fun routeToolCall(args: JSONObject, callback: ToolCallback) {
        val toolName = args.optString("toolName", "")
        if (toolName.isEmpty()) {
            callback.onResponse(false, "Error: Missing toolName parameter.")
            return
        }

        val toolArguments = args.optJSONObject("arguments") ?: JSONObject()

        if (toolName == "capture_photo") {
            executeCaptureAndUploadPhoto(toolArguments, callback)
            return
        }

        // Standard tool invocation request
        backgroundExecutor.submit {
            val isSandbox = toolArguments.optBoolean("sandbox", false) || 
                            toolArguments.optString("destinationPath", "").contains("sandbox", ignoreCase = true) || 
                            targetSandbox
            val actualPort = if (isSandbox) gatewayPort + 6 else gatewayPort
            val url = "http://$gatewayIP:$actualPort/tools/invoke"
            
            val payload = JSONObject()
            payload.put("tool", toolName)
            payload.put("arguments", toolArguments)

            val mediaType = "application/json; charset=utf-8".toMediaType()
            val requestBody = payload.toString().toRequestBody(mediaType)

            val request = Request.Builder()
                .url(url)
                .post(requestBody)
                .addHeader("Authorization", "Bearer $bearerToken")
                .addHeader("Content-Type", "application/json")
                .build()

            try {
                httpClient.newCall(request).execute().use { response ->
                    val bodyString = response.body?.string() ?: ""
                    if (response.isSuccessful) {
                        mainHandler.post { callback.onResponse(true, bodyString) }
                    } else {
                        if (response.code == 500) {
                            // Suppress noisy logs if it's a non-essential status query
                            System.out.println("[OpenClawToolRouter] Suppressed HTTP 500 for path: ${request.url.encodedPath}")
                            mainHandler.post { callback.onResponse(false, "Gateway returned HTTP code 500 (silent)") }
                        } else {
                            mainHandler.post { callback.onResponse(false, "Gateway returned HTTP code ${response.code}: $bodyString") }
                        }
                    }
                }
            } catch (e: IOException) {
                System.out.println("[OpenClawToolRouter] Suppressed network connection issue for path: ${request.url.encodedPath}")
                mainHandler.post { callback.onResponse(false, "OpenClaw Network IO Error: ${e.message}") }
            }
        }
    }

    /**
     * captures a photo asynchronously and uploads it to the OpenClaw host directory (~/.openclaw/workspace).
     */
    private fun executeCaptureAndUploadPhoto(arguments: JSONObject, callback: ToolCallback) {
        if (isUploadInFlight) {
            System.out.println("[OpenClawToolRouter] Skip capture_photo: previous upload is still in-flight.")
            callback.onResponse(false, "Photo upload skipped: previous upload is still in-flight.")
            return
        }

        System.out.println("[OpenClawToolRouter] Launching async capture_photo capture thread...")
        isUploadInFlight = true

        CoroutineScope(Dispatchers.IO).launch {
            try {
                // 1. Retrieve the latest active frame bytes from the smart glasses camera stream session
                val jpegBytes = VideoPipeline.shared.lastFrameBytes ?: run {
                    System.out.println("[OpenClawToolRouter] Error: No active camera stream frame captured yet.")
                    mainHandler.post {
                        callback.onResponse(false, "Error: No active camera stream frame captured yet. Device is offline or has not streamed any frames.")
                    }
                    isUploadInFlight = false
                    return@launch
                }

                // 2. Determine Sandbox offset dynamically
                val destinationPath = arguments.optString("destinationPath", "~/.openclaw/workspace/capture_${System.currentTimeMillis()}.jpg")
                val isSandbox = arguments.optBoolean("sandbox", false) || 
                                destinationPath.contains("sandbox", ignoreCase = true) || 
                                targetSandbox
                val actualPort = if (isSandbox) gatewayPort + 6 else gatewayPort
                val uploadUrl = "http://$gatewayIP:$actualPort/workspace/upload"

                // 3. Save to local filesystem first to allow sync and prevent memory bloat
                val homeDir = System.getProperty("user.home") ?: ""
                val resolvedPath = destinationPath.replace("~", homeDir)
                val localFile = java.io.File(resolvedPath)
                try {
                    localFile.parentFile?.mkdirs()
                    localFile.writeBytes(jpegBytes)
                    System.out.println("[OpenClawToolRouter] Successfully saved local photo to host path: ${localFile.absolutePath}")
                } catch (e: Exception) {
                    System.err.println("[OpenClawToolRouter] Failed to write local copy to disk: ${e.message}")
                }

                // Load from disk for upload payload to prevent excessive RAM utilization
                val fileData = if (localFile.exists()) localFile.readBytes() else jpegBytes
                val filename = localFile.name

                val multipartBody = MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart("destinationPath", destinationPath)
                    .addFormDataPart(
                        "file",
                        filename,
                        fileData.toRequestBody("image/jpeg".toMediaType())
                    )
                    .build()

                val request = Request.Builder()
                    .url(uploadUrl)
                    .post(multipartBody)
                    .addHeader("Authorization", "Bearer $bearerToken")
                    .build()

                httpClient.newCall(request).execute().use { response ->
                    if (response.isSuccessful) {
                        mainHandler.post {
                            System.out.println("[OpenClawToolRouter] Photo successfully saved to $destinationPath")
                            callback.onResponse(true, "Photo successfully saved to OpenClaw workspace: $destinationPath")
                        }
                    } else {
                        mainHandler.post {
                            callback.onResponse(false, "Workspace photo upload failed with status code ${response.code}")
                        }
                    }
                }
            } catch (e: Exception) {
                mainHandler.post {
                    callback.onResponse(false, "Failed to capture and upload photo: ${e.message}")
                }
            } finally {
                isUploadInFlight = false
            }
        }
    }
}
