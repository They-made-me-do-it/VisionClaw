// MainActivity.kt
// VisionClaw
// Main controller for wearable gateway, handling UI, diagnostics, and session orchestration

package com.visionclaw.wearable

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.LinearLayout
import android.bluetooth.BluetoothAdapter
import android.speech.tts.TextToSpeech
import java.util.Locale
import org.json.JSONObject
import java.io.IOException

class MainActivity : Activity(), TextToSpeech.OnInitListener {
    private val TAG = "VisionClaw"
    
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

    private var activeBackend = "GEMINI_LIVE"
    private var isGeminiActive = false
    private var isWebRTCActive = false
    private var audioManager: AudioManager? = null

    private var tts: TextToSpeech? = null

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            Log.i(TAG, "TTS Initialized")
            tts?.language = Locale.US
            speak("System Initializing.")
        }
    }

    private fun speak(text: String) {
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, null)
    }

    private fun getResId(resName: String, resType: String): Int {
        return resources.getIdentifier(resName, resType, packageName)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i(TAG, "onCreate entry")
        
        val layoutId = getResId("activity_main", "layout")
        if (layoutId != 0) {
            setContentView(layoutId)
            Log.i(TAG, "Layout set: " + layoutId)
        } else {
            Log.e(TAG, "CRITICAL: activity_main layout not found!")
            return
        }

        tts = TextToSpeech(this, this)

        apiKeyInput = findViewById(getResId("api_key_input", "id"))
        gatewayIpInput = findViewById(getResId("gateway_ip_input", "id"))
        gatewayTokenInput = findViewById(getResId("gateway_token_input", "id"))
        signalingUrlInput = findViewById(getResId("webrtc_url_input", "id"))

        geminiBtn = findViewById(getResId("btn_toggle_gemini", "id"))
        webrtcBtn = findViewById(getResId("btn_toggle_webrtc", "id"))
        statusText = findViewById(getResId("tv_status", "id"))

        backendToggleBtn = findViewById(getResId("btn_toggle_backend", "id"))
        mmduet2Card = findViewById(getResId("card_mmduet2", "id"))
        mmduet2ResetBtn = findViewById(getResId("btn_reset_mmduet2", "id"))
        mmduet2PromptInput = findViewById(getResId("et_mmduet2_prompt", "id"))
        mmduet2OverlayText = findViewById(getResId("tv_overlay_status", "id"))

        audioManager = AudioManager(this)
        GeminiLiveService.shared.audioManager = audioManager

        backendToggleBtn.setOnClickListener {
            activeBackend = if (activeBackend == "GEMINI_LIVE") "MMDUET2_LOCAL" else "GEMINI_LIVE"
            backendToggleBtn.text = "ACTIVE BACKEND: " + activeBackend
            mmduet2Card.visibility = if (activeBackend == "MMDUET2_LOCAL") android.view.View.VISIBLE else android.view.View.GONE
        }

        geminiBtn.setOnClickListener { toggleGeminiLive() }
        webrtcBtn.setOnClickListener { toggleWebRTC() }
        
        mmduet2ResetBtn.setOnClickListener { resetMMDuet2Server() }

        Log.i(TAG, "Starting config fetch thread")
        val t = object : Thread() {
            override fun run() {
                try {
                    Log.i(TAG, "Thread started, waiting 2s...")
                    Thread.sleep(2000)
                    val client = okhttp3.OkHttpClient()
                    val request = okhttp3.Request.Builder().url("http://localhost:18790/api/config").build()
                    Log.i(TAG, "Executing blocking GET...")
                    val response = client.newCall(request).execute()
                    val code = response.code
                    Log.i(TAG, "Blocking GET Result: " + code)
                    val b = response.body
                    val bodyStr = b?.string()
                    response.close()
                    
                    if (code == 200 && bodyStr != null) {
                        val json = JSONObject(bodyStr)
                        runOnUiThread {
                            if (json.has("geminiApiKey")) apiKeyInput.setText(json.getString("geminiApiKey"))
                            if (json.has("gatewayToken")) gatewayTokenInput.setText(json.getString("gatewayToken"))
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Blocking GET ERROR: " + (e.message ?: "unknown"))
                }
            }
        }
        t.start()
        
        startDiagnosticLoop()
    }

    private fun startDiagnosticLoop() {
        val handler = Handler(Looper.getMainLooper())
        handler.post(object : Runnable {
            override fun run() {
                sendDiagnosticReport()
                handler.postDelayed(this, 10000)
            }
        })
    }

    private fun getWearableConnectionStatus(): JSONObject {
        val status = JSONObject()
        try {
            val adapter = BluetoothAdapter.getDefaultAdapter()
            if (adapter != null && adapter.isEnabled) {
                val pairedDevices = adapter.bondedDevices
                val metaGlasses = pairedDevices.find { it.name.contains("RB Meta", ignoreCase = true) || it.name.contains("Ray-Ban", ignoreCase = true) }
                if (metaGlasses != null) {
                    status.put("paired", true)
                    status.put("name", metaGlasses.name)
                    status.put("address", metaGlasses.address)
                }
            }
        } catch (e: Exception) {}
        return status
    }

    private fun sendDiagnosticReport() {
        val report = JSONObject()
        report.put("timestamp", System.currentTimeMillis())
        report.put("isGeminiActive", isGeminiActive)
        report.put("isGeminiSetupComplete", GeminiLiveService.shared.isSetupComplete)
        report.put("isWebRTCActive", isWebRTCActive)
        report.put("audioHardware", audioManager?.getHardwareReport() ?: JSONObject().put("status", "not_init"))
        report.put("wearableStatus", getWearableConnectionStatus())
        report.put("connectionType", "USB_TUNNEL_V27_STABLE")

        val client = okhttp3.OkHttpClient()
        val body = okhttp3.RequestBody.create(null, report.toString())
        val request = okhttp3.Request.Builder().url("http://localhost:18790/api/diagnostics").post(body).build()

        client.newCall(request).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: IOException) {
                Log.e(TAG, "Diag report failed: " + (e.message ?: "unknown"))
            }
            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                response.use { resp ->
                    if (resp.isSuccessful) {
                        val b = resp.body
                        val bStr = b?.string()
                        if (bStr != null) {
                            try {
                                val json = JSONObject(bStr)
                                if (json.has("averageRtt")) {
                                    val avgRtt = json.getDouble("averageRtt")
                                    VideoPipeline.shared.updateRttMetric(avgRtt)
                                }
                            } catch (e: Exception) {}
                        }
                    }
                }
            }
        })
    }

    private fun toggleGeminiLive() {
        if (!isGeminiActive) startGeminiSession() else stopGeminiSession()
    }

    private fun toggleWebRTC() {
        if (!isWebRTCActive) {
            isWebRTCActive = true
            speak("Streaming.")
        } else {
            isWebRTCActive = false
        }
    }

    private fun startGeminiSession() {
        val apiKey = apiKeyInput.text.toString().trim()
        if (apiKey.isEmpty()) return

        speak("Connecting.")
        audioManager?.configureBluetoothSCO()

        // Set up OpenClawToolRouter dynamically
        val gatewayIp = gatewayIpInput.text.toString().trim()
        if (gatewayIp.isNotEmpty()) {
            OpenClawToolRouter.shared.gatewayIP = gatewayIp
        }
        val gatewayToken = gatewayTokenInput.text.toString().trim()
        if (gatewayToken.isNotEmpty()) {
            OpenClawToolRouter.shared.bearerToken = gatewayToken
        }

        // Wire up VideoPipeline frame callback to stream egocentric frames to WSS
        VideoPipeline.shared.onFrameProcessed = { base64Frame ->
            if (isGeminiActive) {
                GeminiLiveService.shared.sendMediaChunk("image/jpeg", base64Frame)
            }
        }
        VideoPipeline.shared.initialize(this, DATDeviceSession(), DATVideoStream())

        GeminiLiveService.shared.connect(apiKey)
        isGeminiActive = true
        statusText.text = "Status: Connecting..."

        audioManager?.startRecording { pcm: ByteArray ->
            if (isGeminiActive) {
                val base64 = android.util.Base64.encodeToString(pcm, android.util.Base64.NO_WRAP)
                GeminiLiveService.shared.sendMediaChunk("audio/pcm;rate=16000", base64)
            }
        }
    }

    private fun stopGeminiSession() {
        isGeminiActive = false
        VideoPipeline.shared.onFrameProcessed = null
        VideoPipeline.shared.stopSessionProactively()
        GeminiLiveService.shared.disconnect()
        audioManager?.stopRecording()
        statusText.text = "Status: Idle"
        speak("Offline.")
    }

    private fun resetMMDuet2Server() {
        val gatewayIp = gatewayIpInput.text.toString().trim()
        val client = okhttp3.OkHttpClient()
        val body = okhttp3.RequestBody.create(null, "")
        val request = okhttp3.Request.Builder().url("http://" + gatewayIp + ":18789/api/reset").post(body).build()
        client.newCall(request).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: IOException) {}
            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {}
        })
    }

    override fun onDestroy() {
        super.onDestroy()
        tts?.stop()
        tts?.shutdown()
        stopGeminiSession()
    }
}
