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

public class MainActivity : Activity() {

    private lateinit var apiKeyInput: EditText
    private lateinit var gatewayIpInput: EditText
    private lateinit var gatewayTokenInput: EditText
    private lateinit var signalingUrlInput: EditText

    private lateinit var geminiBtn: Button
    private lateinit var webrtcBtn: Button
    private lateinit var statusText: TextView

    private var isGeminiActive = false
    private var isWebRTCActive = false
    private var audioManager: AudioManager? = null
    private var openClawDiscovery: OpenClawDiscovery? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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
            setHintTextColor(0xFF9CA3AF.toInt())
            setTextColor(0xFFF3F4F6.toInt())
            setPadding(20, 20, 20, 20)
        }
        layout.addView(apiKeyInput)

        gatewayIpInput = EditText(this).apply {
            hint = "OpenClaw Gateway IP (default: 192.168.1.100)"
            setHintTextColor(0xFF9CA3AF.toInt())
            setTextColor(0xFFF3F4F6.toInt())
            setPadding(20, 20, 20, 20)
        }
        layout.addView(gatewayIpInput)

        gatewayTokenInput = EditText(this).apply {
            hint = "OpenClaw Gateway Token"
            setHintTextColor(0xFF9CA3AF.toInt())
            setTextColor(0xFFF3F4F6.toInt())
            setPadding(20, 20, 20, 20)
        }
        layout.addView(gatewayTokenInput)

        signalingUrlInput = EditText(this).apply {
            hint = "WebRTC Signaling URL"
            setHintTextColor(0xFF9CA3AF.toInt())
            setTextColor(0xFFF3F4F6.toInt())
            setPadding(20, 20, 20, 20)
        }
        layout.addView(signalingUrlInput)

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
                GeminiLiveService.shared.sendMediaChunk("audio/pcm", base64Audio)
            }
        }
        GeminiLiveService.shared.audioManager = am
        this.audioManager = am

        // 2. Wire up VideoPipeline frame callback to stream egocentric frames to WSS
        VideoPipeline.shared.onFrameProcessed = { base64Frame ->
            if (isGeminiActive) {
                GeminiLiveService.shared.sendMediaChunk("image/jpeg", base64Frame)
            }
        }
        // Initialize DAT stream (using mock references matching SDK 0.7.0 lifecycle API)
        VideoPipeline.shared.initializeDATStream(DATDeviceSession(), DATVideoStream())

        // 3. Connect the websocket
        GeminiLiveService.shared.connect(apiKey)
        
        isGeminiActive = true
        geminiBtn.text = "Disconnect Gemini Live"
        statusText.text = "Status: Connected to Gemini Live WSS"
        statusText.setTextColor(0xFF10B981.toInt()) // Success color
    }

    private fun stopGeminiSession() {
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

        isGeminiActive = false
        geminiBtn.text = "Start Gemini Live Session"
        statusText.text = "Status: Idle"
        statusText.setTextColor(0xFF9CA3AF.toInt())
    }

    private fun startWebRTCSession() {
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
}
