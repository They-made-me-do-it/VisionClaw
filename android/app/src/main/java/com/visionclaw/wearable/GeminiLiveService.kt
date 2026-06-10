// GeminiLiveService.kt
// VisionClaw
// Android Gemini Live API WebSocket Client for media streaming and tool delegation

package com.visionclaw.wearable

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import android.util.Base64

public class GeminiLiveService private constructor() {
    companion object {
        public val shared: GeminiLiveService = GeminiLiveService()
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(0, java.util.concurrent.TimeUnit.SECONDS) // For WebSocket
        .writeTimeout(0, java.util.concurrent.TimeUnit.SECONDS)
        .build()
    private var webSocket: WebSocket? = null
    
    private var apiKeyCached: String? = null
    private var reconnectAttempts = 0
    private val maxReconnectAttempts = 10
    private val baseDelayMs = 1000L
    private val maxDelayMs = 30000L
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
    
    // Resumption token to recover state after network drops/reconnections
    private var lastResumptionToken: String? = null
    
    // Circuit Breaker state
    private var consecutiveFailures = 0
    private val failureThreshold = 3
    private var circuitTripped = false
    private var circuitTrippedTime = 0L
    private val circuitCooldownMs = 60000L // 1 minute

    public var audioManager: AudioManager? = null

    /**
     * Initializes the Secure WebSocket connection to the Gemini Live API
     */
    public fun connect(apiKey: String) {
        this.apiKeyCached = apiKey
        isSetupComplete = false
        
        // Use v1beta for production Gemini 2.0 Flash Exp Bidi support
        val url = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=$apiKey"
        val request = Request.Builder().url(url).build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                System.out.println("[GeminiLiveService] WebSocket open. Response: $response")
                reconnectAttempts = 0
                mainHandler.postDelayed({ sendSetupMessage() }, 800)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleServerMessage(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                audioManager?.playAudio(bytes.toByteArray())
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                System.err.println("[GeminiLiveService] WebSocket Failure: ${t.message}")
                handleDisconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                System.out.println("[GeminiLiveService] WebSocket Closed: $reason")
                handleDisconnect()
            }
        })
    }

    private fun sendSetupMessage() {
        val setupPayload = JSONObject()
        val setup = JSONObject()
        // Production model ID for Multimodal Live
        setup.put("model", "models/gemini-2.5-flash-native-audio-preview-09-2025")
        setupPayload.put("setup", setup)

        val jsonString = setupPayload.toString()
        System.out.println("[GeminiLiveService] Sending setup JSON: $jsonString")
        webSocket?.send(jsonString)
    }

    public var isSetupComplete: Boolean = false
        private set

    /**
     * Parses server response message JSON
     */
    private fun handleServerMessage(text: String) {
        System.out.println("[GeminiLiveService] RAW: $text")
        try {
            val json = JSONObject(text)
            
            if (json.has("setupComplete")) {
                System.out.println("[GeminiLiveService] Handshake COMPLETED.")
                isSetupComplete = true
                sendIntroductionPrompt()
            }
            
            if (json.has("serverContent")) {
                val serverContent = json.getJSONObject("serverContent")
                val modelTurn = serverContent.optJSONObject("modelTurn")
                val parts = modelTurn?.optJSONArray("parts") ?: serverContent.optJSONArray("parts")
                
                if (parts != null) {
                    for (i in 0 until parts.length()) {
                        val part = parts.getJSONObject(i)
                        if (part.has("inlineData")) {
                            val inlineData = part.getJSONObject("inlineData")
                            val mime = inlineData.optString("mimeType", "")
                            if (mime.contains("audio/pcm")) {
                                val base64Data = inlineData.getString("data")
                                val audioBytes = Base64.decode(base64Data, Base64.DEFAULT)
                                audioManager?.playAudio(audioBytes)
                            }
                        }
                    }
                }
            }

            // Session Resumption
            if (json.has("sessionResumptionUpdate")) {
                val resumption = json.getJSONObject("sessionResumptionUpdate")
                val token = resumption.optString("new_handle") ?: resumption.optString("resumptionToken")
                if (token != null && token.isNotEmpty()) {
                    lastResumptionToken = token
                }
            }

            // Tool Calls
            if (json.has("toolCall")) {
                val toolCall = json.getJSONObject("toolCall")
                val functionCalls = toolCall.optJSONArray("functionCalls")
                if (functionCalls != null) {
                    for (i in 0 until functionCalls.length()) {
                        val call = functionCalls.getJSONObject(i)
                        val name = call.getString("name")
                        val callId = call.getString("id")
                        if (name == "execute") {
                            val args = call.getJSONObject("args")
                            dispatchToolCall(args, callId)
                        }
                    }
                }
            }
        } catch (e: Exception) {
            System.err.println("[GeminiLiveService] Parsing error: ${e.message}")
        }
    }

    private fun dispatchToolCall(args: JSONObject, callId: String) {
        val now = System.currentTimeMillis()
        if (circuitTripped) {
            if (now - circuitTrippedTime > circuitCooldownMs) {
                circuitTripped = false
                consecutiveFailures = 0
            } else {
                sendToolResponse(callId, null, "Tool blocked")
                return
            }
        }

        OpenClawToolRouter.shared.routeToolCall(args, object : OpenClawToolRouter.ToolCallback {
            override fun onResponse(success: Boolean, result: String) {
                if (success) {
                    consecutiveFailures = 0
                    val res = JSONObject()
                    res.put("result", result)
                    sendToolResponse(callId, res, null)
                } else {
                    consecutiveFailures++
                    if (consecutiveFailures >= failureThreshold) {
                        circuitTripped = true
                        circuitTrippedTime = System.currentTimeMillis()
                    }
                    sendToolResponse(callId, null, result)
                }
            }
        })
    }

    private fun sendToolResponse(callId: String, payload: JSONObject?, error: String?) {
        val responseObj = JSONObject()
        responseObj.put("id", callId)
        responseObj.put("name", "execute")
        if (error != null) {
            val errObj = JSONObject()
            errObj.put("error", error)
            responseObj.put("response", errObj)
        } else {
            responseObj.put("response", payload)
        }

        val toolResponse = JSONObject()
        val fr = JSONArray()
        fr.put(responseObj)
        toolResponse.put("functionResponses", fr)

        val clientMessage = JSONObject()
        clientMessage.put("toolResponse", toolResponse)
        webSocket?.send(clientMessage.toString())
    }

    private var lastChunkLogTime = 0L

    /**
     * Streams binary media chunks (PCM audio or JPEG images) to the API
     * Only starts streaming AFTER handshake is confirmed.
     */
    public fun sendMediaChunk(mimeType: String, base64Data: String) {
        if (!isSetupComplete) return

        val now = System.currentTimeMillis()
        if (now - lastChunkLogTime > 5000) {
            System.out.println("[GeminiLiveService] Streaming: $mimeType (${base64Data.length} bytes)")
            lastChunkLogTime = now
        }
        
        val mediaChunk = JSONObject()
        mediaChunk.put("mimeType", mimeType)
        mediaChunk.put("data", base64Data)

        val realtimeInput = JSONObject()
        val chunks = JSONArray()
        chunks.put(mediaChunk)
        realtimeInput.put("mediaChunks", chunks)

        val clientMessage = JSONObject()
        clientMessage.put("realtimeInput", realtimeInput)
        webSocket?.send(clientMessage.toString())
    }

    private fun sendIntroductionPrompt() {
        val prompt = "VisionClaw System Handshake. Gemini, please introduce yourself and ask me for acknowledgment."
        
        val turn = JSONObject()
        turn.put("role", "user")
        val parts = JSONArray()
        parts.put(JSONObject().put("text", prompt))
        turn.put("parts", parts)
        
        val clientContent = JSONObject()
        val turns = JSONArray()
        turns.put(turn)
        clientContent.put("turns", turns)
        
        val clientMessage = JSONObject()
        clientMessage.put("clientContent", clientContent)
        
        System.out.println("[GeminiLiveService] Triggering system handshake.")
        webSocket?.send(clientMessage.toString())
    }

    public fun disconnect() {
        apiKeyCached = null
        isSetupComplete = false
        webSocket?.close(1000, "User Disconnected")
        webSocket = null
        reconnectAttempts = 0
    }

    private fun handleDisconnect() {
        val apiKey = apiKeyCached ?: return
        isSetupComplete = false
        if (reconnectAttempts >= maxReconnectAttempts) return
        val delay = Math.min(baseDelayMs * (1L shl reconnectAttempts), maxDelayMs)
        reconnectAttempts++
        mainHandler.postDelayed({ if (apiKeyCached != null) connect(apiKeyCached!!) }, delay)
    }
}
