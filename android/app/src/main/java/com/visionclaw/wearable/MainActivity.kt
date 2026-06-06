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
        // Initialize DAT stream (e.g. passing a dummy device target object)
        VideoPipeline.shared.initializeDATStream(Any())

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

        // 2. Reset video pipeline callbacks
        VideoPipeline.shared.onFrameProcessed = null

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
        System.out.println("[MainActivity] Destroyed. Clean release complete.")
    }
}
