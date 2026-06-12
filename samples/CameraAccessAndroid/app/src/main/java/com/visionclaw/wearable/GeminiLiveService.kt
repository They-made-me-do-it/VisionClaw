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

    private val client = OkHttpClient()
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
    private var circuitTrippedTime = 0Long
    private val circuitCooldownMs = 60000Long // 1 minute

    public var audioManager: AudioManager? = null

    /**
     * Initializes the Secure WebSocket connection to the Gemini Live API
     */
    public fun connect(apiKey: String) {
        this.apiKeyCached = apiKey
        
        // Close existing active WebSocket connection to prevent duplicate concurrent sessions
        webSocket?.let {
            System.out.println("[GeminiLiveService] Closing existing active WebSocket before connecting...")
            try {
                it.close(1000, "Clean takeover")
            } catch (e: Exception) {
                System.err.println("[GeminiLiveService] Error closing existing socket: ${e.message}")
            }
        }
        webSocket = null

        val url = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=$apiKey"
        val request = Request.Builder().url(url).build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                System.out.println("[GeminiLiveService] WebSocket open. Sending setup...")
                reconnectAttempts = 0
                sendSetupMessage()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleServerMessage(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                // If it is binary audio data from the server, play it directly
                // The binary frame is raw 24 kHz mono Int16 PCM audio
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

    /**
     * Constructs and sends the initial BidiGenerateContentSetup schema payload
     */
    private fun sendSetupMessage() {
        val setup = JSONObject()
        setup.put("model", "models/gemini-3.1-flash-live-preview")

        val generationConfig = JSONObject()
        val modalities = JSONArray()
        modalities.put("AUDIO")
        generationConfig.put("responseModalities", modalities)
        
        val voiceConfig = JSONObject()
        val prebuiltVoiceConfig = JSONObject()
        prebuiltVoiceConfig.put("voiceName", "Puck")
        voiceConfig.put("prebuiltVoiceConfig", prebuiltVoiceConfig)
        
        val speechConfig = JSONObject()
        speechConfig.put("voiceConfig", voiceConfig)
        generationConfig.put("speechConfig", speechConfig)

        setup.put("generationConfig", generationConfig)

        // Configuration to configure context window compression block to survive 2-min session limits
        val slidingWindow = JSONObject()
        slidingWindow.put("targetTokens", 2000)
        val contextWindowCompression = JSONObject()
        contextWindowCompression.put("slidingWindow", slidingWindow)
        setup.put("contextWindowCompression", contextWindowCompression)

        // Tools registration for OpenClaw
        val tools = JSONArray()
        val toolContainer = JSONObject()
        val functionDeclarations = JSONArray()
        
        val functionDecl = JSONObject()
        functionDecl.put("name", "execute")
        functionDecl.put("description", "Execute local action via OpenClaw Gateway on LAN")
        functionDecl.put("behavior", "NON_BLOCKING")

        val parameters = JSONObject()
        parameters.put("type", "OBJECT")
        
        val properties = JSONObject()
        val toolNameParam = JSONObject()
        toolNameParam.put("type", "STRING")
        toolNameParam.put("description", "The target OpenClaw tool name, e.g., capture_photo")
        properties.put("toolName", toolNameParam)
        
        val argsParam = JSONObject()
        argsParam.put("type", "OBJECT")
        argsParam.put("description", "JSON arguments matching tool parameters")
        properties.put("arguments", argsParam)
        
        parameters.put("properties", properties)
        
        val required = JSONArray()
        required.put("toolName")
        parameters.put("required", required)
        
        functionDecl.put("parameters", parameters)
        functionDeclarations.put(functionDecl)
        toolContainer.put("functionDeclarations", functionDeclarations)
        tools.put(toolContainer)
        setup.put("tools", tools)

        // Enable and configure session resumption
        val sessionResumption = JSONObject()
        lastResumptionToken?.let { token ->
            System.out.println("[GeminiLiveService] Resuming session with token: ${token.take(8)}...")
            sessionResumption.put("handle", token)
            // For backward compatibility/mock checks
            setup.put("resumptionToken", token)
        }
        setup.put("sessionResumption", sessionResumption)

        val clientMessage = JSONObject()
        clientMessage.put("setup", setup)

        webSocket?.send(clientMessage.toString())
    }

    /**
     * Parses server response message JSON
     */
    private fun handleServerMessage(text: String) {
        try {
            val json = JSONObject(text)

            // 1. Audio Ingestion (Gemini -> App -> Glasses)
            if (json.has("serverContent")) {
                val serverContent = json.getJSONObject("serverContent")
                if (serverContent.has("parts")) {
                    val parts = serverContent.getJSONArray("parts")
                    for (i in 0 until parts.length()) {
                        val part = parts.getJSONObject(i)
                        if (part.has("inlineData")) {
                            val inlineData = part.getJSONObject("inlineData")
                            val mime = inlineData.optString("mimeType", "")
                            if (mime.contains("audio/pcm")) {
                                val base64Data = inlineData.getString("data")
                                val audioBytes = Base64.decode(base64Data, Base64.DEFAULT)
                                // Forward to output AudioManager stream (24 kHz PCM)
                                audioManager?.playAudio(audioBytes)
                            }
                        }
                        if (part.has("text")) {
                            val txt = part.optString("text", "")
                            if (txt.isNotEmpty()) {
                                System.out.println("[GeminiLiveService] Transcript: $txt")
                            }
                        }
                    }
                }
            }

            // 2. Session Resumption updates
            if (json.has("sessionResumptionUpdate")) {
                val resumption = json.getJSONObject("sessionResumptionUpdate")
                val token = if (resumption.has("new_handle")) {
                    resumption.getString("new_handle")
                } else if (resumption.has("resumptionToken")) {
                    resumption.getString("resumptionToken")
                } else if (resumption.has("newHandle")) {
                    resumption.getString("newHandle")
                } else null

                if (token != null) {
                    lastResumptionToken = token
                    System.out.println("[GeminiLiveService] Cached session resumption token: ${lastResumptionToken?.take(10)}...")
                }
            }

            // 3. Intercept Function Calls
            if (json.has("toolCall")) {
                val toolCall = json.getJSONObject("toolCall")
                if (toolCall.has("functionCalls")) {
                    val functionCalls = toolCall.getJSONArray("functionCalls")
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

    /**
     * Handles tool execution routing and circuit breaker evaluations
     */
    private fun dispatchToolCall(args: JSONObject, callId: String) {
        val now = System.currentTimeMillis()
        if (circuitTripped) {
            if (now - circuitTrippedTime > circuitCooldownMs) {
                // Cooldown expired
                circuitTripped = false
                consecutiveFailures = 0
                System.out.println("[GeminiLiveService] Cooldown complete. Resetting circuit breaker.")
            } else {
                System.out.println("[GeminiLiveService] Blocked tool execution: Circuit is TRIPPED.")
                sendToolResponse(callId, null, "Tool call blocked. Circuit breaker is active.")
                return
            }
        }

        OpenClawToolRouter.shared.routeToolCall(args, object : OpenClawToolRouter.ToolCallback {
            override fun onResponse(success: Boolean, result: String) {
                if (success) {
                    consecutiveFailures = 0
                    val payload = JSONObject()
                    payload.put("result", result)
                    sendToolResponse(callId, payload, null)
                } else {
                    consecutiveFailures++
                    System.err.println("[GeminiLiveService] Tool failure logged ($consecutiveFailures/$failureThreshold)")
                    
                    val isSecurityThreat = result.contains("403") || 
                                           result.contains("SECURITY_THREAT_DETECTED") || 
                                           result.contains("SecurityException")
                    if (isSecurityThreat) {
                        circuitTripped = true
                        circuitTrippedTime = System.currentTimeMillis()
                        System.err.println("[GeminiLiveService] Security threat detected in tool call response! Tripping circuit breaker and disconnecting session.")
                        disconnect()
                    } else if (consecutiveFailures >= failureThreshold) {
                        circuitTripped = true
                        circuitTrippedTime = System.currentTimeMillis()
                        System.err.println("[GeminiLiveService] WARNING: Circuit breaker tripped! Halting further queries.")
                    }
                    sendToolResponse(callId, null, result)
                }
            }
        })
    }

    /**
     * Sends back the response to the Gemini server client channel
     */
    private fun sendToolResponse(callId: String, responsePayload: JSONObject?, errorMsg: String?) {
        val responseContainer = JSONObject()
        responseContainer.put("id", callId)
        responseContainer.put("name", "execute")
        responseContainer.put("scheduling", "INTERRUPT")

        if (errorMsg != null) {
            val errObj = JSONObject()
            errObj.put("error", errorMsg)
            responseContainer.put("response", errObj)
        } else if (responsePayload != null) {
            responseContainer.put("response", responsePayload)
        }

        val responses = JSONArray()
        responses.put(responseContainer)

        val toolResponse = JSONObject()
        toolResponse.put("functionResponses", responses)

        val clientMessage = JSONObject()
        clientMessage.put("toolResponse", toolResponse)

        webSocket?.send(clientMessage.toString())
    }

    public fun sendMediaChunk(mimeType: String, base64Data: String) {
        webSocket?.let { ws ->
            if (ws.queueSize() > 0L) {
                System.out.println("[GeminiLiveService] Outbound queue has ${ws.queueSize()} bytes. Dropping media chunk to preserve battery.")
                return
            }
        }

        val mediaChunk = JSONObject()
        mediaChunk.put("mimeType", mimeType)
        mediaChunk.put("data", base64Data)

        val chunks = JSONArray()
        chunks.put(mediaChunk)

        val realtimeInput = JSONObject()
        realtimeInput.put("mediaChunks", chunks)

        val clientMessage = JSONObject()
        clientMessage.put("realtimeInput", realtimeInput)

        webSocket?.send(clientMessage.toString())
    }

    public fun disconnect() {
        apiKeyCached = null
        webSocket?.close(1000, "User Disconnected")
        webSocket = null
        reconnectAttempts = 0
        System.out.println("[GeminiLiveService] WebSocket manually disconnected.")
    }

    private fun handleDisconnect() {
        val apiKey = apiKeyCached ?: return
        if (reconnectAttempts >= maxReconnectAttempts) {
            System.err.println("[GeminiLiveService] Max reconnect attempts ($maxReconnectAttempts) reached. Reconnection aborted.")
            return
        }
        val delay = Math.min(baseDelayMs * (1L shl reconnectAttempts), maxDelayMs)
        reconnectAttempts++
        System.out.println("[GeminiLiveService] Reconnecting in $delay ms (Attempt $reconnectAttempts/$maxReconnectAttempts)...")
        mainHandler.postDelayed({
            if (apiKeyCached != null) {
                connect(apiKeyCached!!)
            }
        }, delay)
    }
}
