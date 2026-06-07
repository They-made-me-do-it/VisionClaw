// MainActivity.kt
// VisionClaw
// Android Gateway Controller Activity

package com.visionclaw.wearable

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

public class MainActivity : Activity() {

    private lateinit var apiKeyInput: EditText
    private lateinit var gatewayIpInput: EditText
    private lateinit var gatewayTokenInput: EditText
    private lateinit var signalingUrlInput: EditText

    private lateinit var geminiBtn: Button
    private lateinit var webrtcBtn: Button
    private lateinit var statusText: TextView

    private lateinit var backendToggleBtn: Button
    private lateinit var mmduet2Card: LinearLayout
    private lateinit var mmduet2ResetBtn: Button
    private lateinit var mmduet2PromptInput: EditText
    private lateinit var mmduet2OverlayText: TextView

    private var activeBackend: String = "Gemini Live" // or "MMDuet2"
    private var mmduet2FrameCount = 0
    private var mmduet2KVCacheSize = 0

    private var isGeminiActive = false
    private var isWebRTCActive = false
    private var audioManager: AudioManager? = null
    private var openClawDiscovery: OpenClawDiscovery? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Set up global exception handler to alert on HW slot locks
        val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            System.err.println("[VisionClaw] CRITICAL: Uncaught exception in thread ${thread.name}: ${throwable.message}")
            System.err.println("[VisionClaw] Note: Hardware broadcast slot might be locked. If the smart glasses block downstream connections, please execute a physical case-hinge reset to reclaim the device.")
            defaultHandler?.uncaughtException(thread, throwable)
        }

        // Programmatic premium dark mode layout setup
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(40, 60, 40, 60)
            setBackgroundColor(0xFF07090E.toInt()) // dark theme
        }

        val titleText = TextView(this).apply {
            text = "VISIONCLAW EDGE GATEWAY"
            textSize = 20f
            setTextColor(0xFFF3F4F6.toInt())
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 40)
        }
        layout.addView(titleText)

        // Form fields
        apiKeyInput = EditText(this).apply {
            hint = "Gemini API Key"
            setText("AIzaSyAq9doF17T9IEX5nD4zXxEm2XberYGApYw")
            setHintTextColor(0xFF9CA3AF.toInt())
            setTextColor(0xFFF3F4F6.toInt())
            setPadding(20, 20, 20, 20)
        }
        layout.addView(apiKeyInput)

        gatewayIpInput = EditText(this).apply {
            hint = "OpenClaw Gateway IP (default: 192.168.1.100)"
            setText("192.168.20.151")
            setHintTextColor(0xFF9CA3AF.toInt())
            setTextColor(0xFFF3F4F6.toInt())
            setPadding(20, 20, 20, 20)
        }
        layout.addView(gatewayIpInput)

        gatewayTokenInput = EditText(this).apply {
            hint = "OpenClaw Gateway Token"
            setText("bcc2b8fb978d0aaab930713064dff7ac9c801c2e7e6a5f16")
            setHintTextColor(0xFF9CA3AF.toInt())
            setTextColor(0xFFF3F4F6.toInt())
            setPadding(20, 20, 20, 20)
        }
        layout.addView(gatewayTokenInput)

        signalingUrlInput = EditText(this).apply {
            hint = "WebRTC Signaling URL"
            setText("ws://192.168.20.151:18790")
            setHintTextColor(0xFF9CA3AF.toInt())
            setTextColor(0xFFF3F4F6.toInt())
            setPadding(20, 20, 20, 20)
        }
        layout.addView(signalingUrlInput)

        // MMDuet2 Backend Selector & Tab Controls Card
        backendToggleBtn = Button(this).apply {
            text = "Active Backend: Gemini Live"
            setBackgroundColor(0xFF3B82F6.toInt()) // premium blue
            setTextColor(0xFFFFFFFF.toInt())
            setOnClickListener {
                if (activeBackend == "Gemini Live") {
                    activeBackend = "MMDuet2"
                    text = "Active Backend: MMDuet2"
                    setBackgroundColor(0xFF8B5CF6.toInt()) // premium purple
                    mmduet2Card.visibility = android.view.View.VISIBLE
                } else {
                    activeBackend = "Gemini Live"
                    text = "Active Backend: Gemini Live"
                    setBackgroundColor(0xFF3B82F6.toInt()) // premium blue
                    mmduet2Card.visibility = android.view.View.GONE
                }
            }
        }
        layout.addView(backendToggleBtn)

        mmduet2Card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(30, 30, 30, 30)
            visibility = android.view.View.GONE
            val drawable = android.graphics.drawable.GradientDrawable().apply {
                setColor(0xFF1E293B.toInt()) // dark card color
                setStroke(2, 0xFF334155.toInt())
                cornerRadius = 12f
            }
            background = drawable
            
            // Layout params to add spacing
            val params = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 20, 0, 20)
            }
            layoutParams = params
        }
        
        val mmduet2Title = TextView(this).apply {
            text = "MMDuet2 Configuration"
            textSize = 16f
            setTextColor(0xFFF3F4F6.toInt())
            setPadding(0, 0, 0, 10)
        }
        mmduet2Card.addView(mmduet2Title)
        
        mmduet2PromptInput = EditText(this).apply {
            hint = "Prompt Configurations"
            setHintTextColor(0xFF9CA3AF.toInt())
            setTextColor(0xFFF3F4F6.toInt())
            setPadding(10, 10, 10, 10)
        }
        mmduet2Card.addView(mmduet2PromptInput)
        
        mmduet2ResetBtn = Button(this).apply {
            text = "Reset Server Configuration"
            setOnClickListener { resetMMDuet2Server() }
        }
        mmduet2Card.addView(mmduet2ResetBtn)
        
        mmduet2OverlayText = TextView(this).apply {
            text = "MMDuet2 Active Parameters:\nResolution: 504x896 (Medium)\nFPS: 1.0 (Throttled)\nFrame Count: 0\nIn-flight Status: Idle\nKV Cache Size: 0 / 20000 tokens"
            textSize = 12f
            setTextColor(0xFF9CA3AF.toInt())
            setPadding(0, 10, 0, 0)
        }
        mmduet2Card.addView(mmduet2OverlayText)
        
        layout.addView(mmduet2Card)

        // Status field
        statusText = TextView(this).apply {
            text = "Status: Idle"
            textSize = 14f
            setTextColor(0xFF9CA3AF.toInt())
            setPadding(0, 40, 0, 40)
        }
        layout.addView(statusText)

        // Action Buttons
        geminiBtn = Button(this).apply {
            text = "Start Gemini Live Session"
            setOnClickListener { toggleGeminiLive() }
        }
        layout.addView(geminiBtn)

        webrtcBtn = Button(this).apply {
            text = "Start WebRTC POV Broadcast"
            setOnClickListener { toggleWebRTC() }
        }
        layout.addView(webrtcBtn)

        setContentView(layout)

        // Start dynamic mDNS autodiscovery for OpenClaw Gateway on launch
        openClawDiscovery = OpenClawDiscovery(this) { host, port ->
            runOnUiThread {
                gatewayIpInput.setText(host)
                OpenClawToolRouter.shared.gatewayIP = host
                OpenClawToolRouter.shared.gatewayPort = port
                statusText.text = "Status: OpenClaw Resolved at $host:$port"
                statusText.setTextColor(0xFF10B981.toInt())
                Toast.makeText(this, "Discovered OpenClaw Gateway at $host:$port", Toast.LENGTH_SHORT).show()
            }

            // Dynamically pull configuration from dashboard server on port 18790
            val client = okhttp3.OkHttpClient()
            val request = okhttp3.Request.Builder()
                .url("http://$host:18790/api/config")
                .build()

            client.newCall(request).enqueue(object : okhttp3.Callback {
                override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                    System.err.println("[MainActivity] Failed to pull config from dashboard server: ${e.message}")
                }

                override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                    response.use { resp ->
                        if (resp.isSuccessful) {
                            val bodyString = resp.body?.string() ?: ""
                            try {
                                val json = org.json.JSONObject(bodyString)
                                val geminiKey = json.optString("geminiApiKey", "")
                                val gatewayTok = json.optString("gatewayToken", "")
                                
                                runOnUiThread {
                                    if (geminiKey.isNotEmpty()) {
                                        apiKeyInput.setText(geminiKey)
                                    }
                                    if (gatewayTok.isNotEmpty()) {
                                        gatewayTokenInput.setText(gatewayTok)
                                        OpenClawToolRouter.shared.bearerToken = gatewayTok
                                    }
                                    Toast.makeText(this@MainActivity, "Credentials auto-configured over LAN!", Toast.LENGTH_SHORT).show()
                                }
                            } catch (e: Exception) {
                                System.err.println("[MainActivity] Failed to parse config JSON: ${e.message}")
                            }
                        }
                    }
                }
            })
        }
        openClawDiscovery?.startDiscovery()
    }

    private fun toggleGeminiLive() {
        if (isGeminiActive) {
            stopGeminiSession()
        } else {
            // Assert resource exclusion: Cannot run simultaneously with WebRTC
            if (isWebRTCActive) {
                stopWebRTCSession()
            }
            startGeminiSession()
        }
    }

    private fun toggleWebRTC() {
        if (isWebRTCActive) {
            stopWebRTCSession()
        } else {
            // Assert resource exclusion: Cannot run simultaneously with Gemini Live
            if (isGeminiActive) {
                stopGeminiSession()
            }
            startWebRTCSession()
        }
    }

    private fun startGeminiSession() {
        trackStateTransition()
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), 101)
                Toast.makeText(this, "Please grant microphone permission and try again.", Toast.LENGTH_LONG).show()
                return
            }
        }
        val apiKey = apiKeyInput.text.toString().trim()
        if (apiKey.isEmpty()) {
            Toast.makeText(this, "Please enter a valid Gemini API Key", Toast.LENGTH_SHORT).show()
            return
        }

        val gatewayIp = gatewayIpInput.text.toString().trim()
        if (gatewayIp.isNotEmpty()) {
            OpenClawToolRouter.shared.gatewayIP = gatewayIp
        }

        val gatewayToken = gatewayTokenInput.text.toString().trim()
        if (gatewayToken.isNotEmpty()) {
            OpenClawToolRouter.shared.bearerToken = gatewayToken
        }

        System.out.println("[MainActivity] Starting Gemini Live API integration session.")
        
        // 1. Initialize and start AudioManager routing SCO audio
        val am = AudioManager(this)
        am.startRecording { pcmChunk ->
            if (isGeminiActive) {
                val base64Audio = android.util.Base64.encodeToString(pcmChunk, android.util.Base64.NO_WRAP)
                GeminiLiveService.shared.sendMediaChunk("audio/pcm;rate=16000", base64Audio)
            }
        }
        GeminiLiveService.shared.audioManager = am
        this.audioManager = am

        // 2. Wire up VideoPipeline frame callback to stream egocentric frames to WSS
        VideoPipeline.shared.onFrameProcessed = { base64Frame ->
            if (isGeminiActive) {
                if (activeBackend == "Gemini Live") {
                    GeminiLiveService.shared.sendMediaChunk("image/jpeg", base64Frame)
                } else if (activeBackend == "MMDuet2") {
                    streamFrameToMMDuet2(base64Frame)
                }
            }
        }
        // Initialize DAT stream (using mock references matching SDK 0.7.0 lifecycle API)
        VideoPipeline.shared.initializeDATStream(DATDeviceSession(), DATVideoStream())

        if (activeBackend == "Gemini Live") {
            // 3. Connect the websocket
            GeminiLiveService.shared.connect(apiKey)
            
            // 4. Connect OpenClaw Event Client WSS earlier
            OpenClawToolRouter.shared.connectEventClient()
            
            statusText.text = "Status: Connected to Gemini Live WSS"
        } else {
            // Automatically reset the server configuration at the start of a session
            resetMMDuet2Server()
            statusText.text = "Status: Connected to MMDuet2 API"
        }
        
        isGeminiActive = true
        geminiBtn.text = "Disconnect Gemini Live"
        statusText.setTextColor(0xFF10B981.toInt()) // Success color
    }

    private fun stopGeminiSession() {
        trackStateTransition()
        System.out.println("[MainActivity] Terminating Gemini Live session.")
        
        // 1. Stop audio recording and release SCO channels
        audioManager?.stopRecording()
        audioManager = null
        GeminiLiveService.shared.audioManager = null

        // 2. Reset video pipeline callbacks and stop wearable session to free broadcast slot
        VideoPipeline.shared.onFrameProcessed = null
        VideoPipeline.shared.stopSessionProactively()

        // 3. Disconnect WebSocket session cleanly to prevent network leaks
        GeminiLiveService.shared.disconnect()

        // 4. Disconnect OpenClaw Event Client WSS
        OpenClawToolRouter.shared.disconnectEventClient()

        isGeminiActive = false
        geminiBtn.text = "Start Gemini Live Session"
        statusText.text = "Status: Idle"
        statusText.setTextColor(0xFF9CA3AF.toInt())
    }

    private fun startWebRTCSession() {
        trackStateTransition()
        val signalingUrl = signalingUrlInput.text.toString().trim()
        if (signalingUrl.isEmpty()) {
            Toast.makeText(this, "Please enter signaling socket URL", Toast.LENGTH_SHORT).show()
            return
        }

        try {
            System.out.println("[MainActivity] Attempting WebRTC initialization.")
            WebRTCClient.shared.startPOVBroadcast(signalingUrl)
            
            // Wire VideoPipeline to ingest high-frequency 24 fps broadcast frames directly
            VideoPipeline.shared.onFrameProcessed = { base64Frame ->
                // Note: Bypasses typical 1 fps throttling for WebRTC POV stream
            }
            
            isWebRTCActive = true
            webrtcBtn.text = "Stop POV WebRTC Broadcast"
            statusText.text = "Status: Broadcasting POV live stream"
            statusText.setTextColor(0xFF3B82F6.toInt()) // Info color
        } catch (e: Exception) {
            Toast.makeText(this, "Error starting WebRTC: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun stopWebRTCSession() {
        trackStateTransition()
        System.out.println("[MainActivity] Halting WebRTC broadcaster.")
        WebRTCClient.shared.stopPOVBroadcast()
        VideoPipeline.shared.onFrameProcessed = null
        isWebRTCActive = false
        webrtcBtn.text = "Start WebRTC POV Broadcast"
        statusText.text = "Status: Idle"
        statusText.setTextColor(0xFF9CA3AF.toInt())
    }

    /**
     * Strict Wearable Broadcast Slot Management:
     * If the app is backgrounded, paused, or killed, we proactively stop
     * all active streams to prevent locking the smart glasses' hardware broadcast slot.
     */
    override fun onPause() {
        super.onPause()
        if (isGeminiActive) {
            stopGeminiSession()
        }
        if (isWebRTCActive) {
            stopWebRTCSession()
        }
        VideoPipeline.shared.stopSessionProactively()
        System.out.println("[MainActivity] Paused. Releasing hardware locks to avoid resource contention.")
    }

    override fun onDestroy() {
        super.onDestroy()
        if (isGeminiActive) {
            stopGeminiSession()
        }
        if (isWebRTCActive) {
            stopWebRTCSession()
        }
        VideoPipeline.shared.stopSessionProactively()
        
        // Stop dynamic autodiscovery listener to prevent memory leaks
        openClawDiscovery?.stopDiscovery()
        openClawDiscovery = null
        
        System.out.println("[MainActivity] Destroyed. Clean release complete.")
    }

    private fun streamFrameToMMDuet2(base64Frame: String) {
        val host = OpenClawToolRouter.shared.gatewayIP
        val url = "http://$host:8000/frame"
        
        val payload = org.json.JSONObject()
        payload.put("image", base64Frame)
        payload.put("prompt", mmduet2PromptInput.text.toString().trim())
        
        val mediaType = "application/json; charset=utf-8".toMediaType()
        val requestBody = payload.toString().toRequestBody(mediaType)
        
        val request = okhttp3.Request.Builder()
            .url(url)
            .post(requestBody)
            .build()
            
        val client = okhttp3.OkHttpClient()
        client.newCall(request).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                System.err.println("[MainActivity] MMDuet2 Feed Failed: ${e.message}")
            }
            
            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                response.use { resp ->
                    if (resp.isSuccessful) {
                        val bodyString = resp.body?.string() ?: ""
                        try {
                            val json = org.json.JSONObject(bodyString)
                            val kvCache = json.optInt("kv_cache_size", 0)
                            
                            runOnUiThread {
                                mmduet2FrameCount++
                                mmduet2KVCacheSize = kvCache
                                updateMMDuet2Overlay()
                                
                                // Guardrail: auto reset if kvCache exceeds 20,000 tokens
                                if (kvCache >= 20000) {
                                    System.out.println("[MainActivity] KV Cache exceeds 20,000 tokens ($kvCache). Triggering auto-reset.")
                                    resetMMDuet2Server()
                                    Toast.makeText(this@MainActivity, "Auto-Reset KV Cache (Limit Exceeded)", Toast.LENGTH_SHORT).show()
                                }
                            }
                        } catch (e: Exception) {
                            System.err.println("[MainActivity] Failed to parse MMDuet2 feed response: ${e.message}")
                        }
                    }
                }
            }
        })
    }

    private fun resetMMDuet2Server() {
        val host = OpenClawToolRouter.shared.gatewayIP
        val url = "http://$host:8000/reset"
        val request = okhttp3.Request.Builder()
            .url(url)
            .post("{}".toRequestBody("application/json; charset=utf-8".toMediaType()))
            .build()
            
        val client = okhttp3.OkHttpClient()
        client.newCall(request).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                System.err.println("[MainActivity] MMDuet2 reset failed: ${e.message}")
            }
            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                response.use { resp ->
                    if (resp.isSuccessful) {
                        runOnUiThread {
                            mmduet2KVCacheSize = 0
                            updateMMDuet2Overlay()
                            Toast.makeText(this@MainActivity, "MMDuet2 Server Reset Successful!", Toast.LENGTH_SHORT).show()
                        }
                    } else {
                        System.err.println("[MainActivity] MMDuet2 reset failed with code: ${resp.code}")
                    }
                }
            }
        })
    }

    private fun updateMMDuet2Overlay() {
        val inFlightStr = if (VideoPipeline.shared.lastFrameBytes != null) "Active" else "Idle"
        mmduet2OverlayText.text = """
            MMDuet2 Active Parameters:
            Resolution: 504x896 (Medium)
            FPS: 1.0 (Throttled)
            Frame Count: $mmduet2FrameCount
            In-flight Status: $inFlightStr
            KV Cache Size: $mmduet2KVCacheSize / 20000 tokens
        """.trimIndent()
    }

    private var lastStateTransitionTime = 0L
    private var stateTransitionCount = 0
    private val stateThresholdMs = 3000L // 3 seconds
    
    private fun trackStateTransition() {
        val now = System.currentTimeMillis()
        if (now - lastStateTransitionTime < stateThresholdMs) {
            stateTransitionCount++
            if (stateTransitionCount >= 3) {
                runOnUiThread {
                    val msg = "Warning: Rapid state transitions detected. Hardware broadcast slot might be locked. Please execute a physical case-hinge reset on the smart glasses to reclaim the device."
                    Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
                    statusText.text = "HW Lock Risk - Case Hinge Reset Recommended"
                    statusText.setTextColor(0xFFEF4444.toInt()) // error red
                }
            }
        } else {
            stateTransitionCount = 0
        }
        lastStateTransitionTime = now
    }
}
