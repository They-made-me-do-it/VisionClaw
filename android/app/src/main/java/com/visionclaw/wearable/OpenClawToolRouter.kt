// OpenClawToolRouter.kt
// VisionClaw
// Intercepts tool calls and routes them to the local OpenClaw Gateway on the LAN

package com.visionclaw.wearable

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
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

    public interface ToolCallback {
        public fun onResponse(success: Boolean, result: String)
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
            val url = "http://$gatewayIP:$gatewayPort/tools/invoke"
            
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
                        mainHandler.post { callback.onResponse(false, "Gateway returned HTTP code ${response.code}: $bodyString") }
                    }
                }
            } catch (e: IOException) {
                mainHandler.post { callback.onResponse(false, "OpenClaw Network IO Error: ${e.message}") }
            }
        }
    }

    /**
     * captures a photo asynchronously and uploads it to the OpenClaw host directory (~/.openclaw/workspace).
     */
    private fun executeCaptureAndUploadPhoto(arguments: JSONObject, callback: ToolCallback) {
        System.out.println("[OpenClawToolRouter] Launching async capture_photo capture thread...")

        backgroundExecutor.submit {
            try {
                // 1. Simulate capturing 1080p frame image
                val mockBitmap = Bitmap.createBitmap(1920, 1080, Bitmap.Config.ARGB_8888)
                val outputStream = ByteArrayOutputStream()
                mockBitmap.compress(Bitmap.CompressFormat.JPEG, 80, outputStream)
                val jpegBytes = outputStream.toByteArray()

                // 2. Perform Multipart HTTP POST upload asynchronously
                val uploadUrl = "http://$gatewayIP:$gatewayPort/workspace/upload"
                val filename = "capture_${System.currentTimeMillis()}.jpg"
                val destinationPath = "~/.openclaw/workspace/$filename"

                val multipartBody = MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart("destinationPath", destinationPath)
                    .addFormDataPart(
                        "file",
                        filename,
                        jpegBytes.toRequestBody("image/jpeg".toMediaType())
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
            }
        }
    }
}
