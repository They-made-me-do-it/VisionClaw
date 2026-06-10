// AudioManager.kt
// VisionClaw
// Android hardware audio stream manager for capturing and playing bluetooth streams

package com.visionclaw.wearable

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager as AndroidAudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.AudioDeviceInfo
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue

public class AudioManager(private val context: Context) {
    private val androidAudioManager = context.getSystemService(Context.AUDIO_SERVICE) as AndroidAudioManager
    private val executorService: ExecutorService = Executors.newFixedThreadPool(3)
    private val mainHandler = Handler(Looper.getMainLooper())

    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null
    public var isRecording: Boolean = false
        private set

    private val audioQueue = LinkedBlockingQueue<ByteArray>()
    public var isPlaybackActive: Boolean = false
        private set
    private var playbackThread: Thread? = null

    private var isReceiverRegistered = false

    public var isScoConnected: Boolean = false
        private set

    private val scoReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val state = intent.getIntExtra(AndroidAudioManager.EXTRA_SCO_AUDIO_STATE, -1)
            System.out.println("[AudioManager] SCO Audio State updated: $state")
            if (state == AndroidAudioManager.SCO_AUDIO_STATE_CONNECTED) {
                System.out.println("[AudioManager] Bluetooth SCO link connected. Activating routing.")
                isScoConnected = true
                androidAudioManager.isBluetoothScoOn = true
                androidAudioManager.mode = AndroidAudioManager.MODE_IN_CALL
            } else if (state == AndroidAudioManager.SCO_AUDIO_STATE_DISCONNECTED) {
                isScoConnected = false
                System.out.println("[AudioManager] Bluetooth SCO link disconnected.")
            }
        }
    }

    private fun registerScoReceiver() {
        if (!isReceiverRegistered) {
            context.registerReceiver(scoReceiver, IntentFilter(AndroidAudioManager.ACTION_SCO_AUDIO_STATE_UPDATED))
            isReceiverRegistered = true
        }
    }

    private fun unregisterScoReceiver() {
        if (isReceiverRegistered) {
            try {
                context.unregisterReceiver(scoReceiver)
            } catch (e: Exception) {}
            isReceiverRegistered = false
        }
    }

    private fun startPlaybackLoop() {
        if (isPlaybackActive) return
        isPlaybackActive = true
        playbackThread = Thread {
            while (isPlaybackActive) {
                try {
                    val chunk = audioQueue.take()
                    audioTrack?.write(chunk, 0, chunk.size)
                } catch (e: InterruptedException) {
                    break
                }
            }
        }
        playbackThread?.start()
    }

    private fun stopPlaybackLoop() {
        isPlaybackActive = false
        playbackThread?.interrupt()
        playbackThread = null
    }

    private val sampleRateInput = 16000 // 16 kHz mono Int16 PCM for Gemini Live
    private val bytesPerChunk = 3200 // 100 ms of 16 kHz Int16 PCM (2 bytes per sample)

    private val sampleRateOutput = 24000 // 24 kHz mono Int16 PCM from Gemini Live
    
    private var focusRequest: Any? = null

    private val audioFocusChangeListener = AndroidAudioManager.OnAudioFocusChangeListener { focusChange ->
        when (focusChange) {
            AndroidAudioManager.AUDIOFOCUS_LOSS, 
            AndroidAudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            AndroidAudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                stopRecording()
            }
        }
    }

    /**
     * Requests audio focus for VOICE_COMMUNICATION.
     */
    public fun requestAudioFocus(): Boolean {
        val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AndroidAudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAcceptsDelayedFocusGain(false)
                .setOnAudioFocusChangeListener(audioFocusChangeListener)
                .build()
            focusRequest = request
            androidAudioManager.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            androidAudioManager.requestAudioFocus(
                audioFocusChangeListener,
                AndroidAudioManager.STREAM_VOICE_CALL,
                AndroidAudioManager.AUDIOFOCUS_GAIN_TRANSIENT
            )
        }
        val success = result == AndroidAudioManager.AUDIOFOCUS_REQUEST_GRANTED
        System.out.println("[AudioManager] Audio focus request status: ${if (success) "GRANTED" else "DENIED"}")
        return success
    }

    /**
     * Abandons audio focus.
     */
    public fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            (focusRequest as? AudioFocusRequest)?.let {
                androidAudioManager.abandonAudioFocusRequest(it)
            }
            focusRequest = null
        } else {
            @Suppress("DEPRECATION")
            androidAudioManager.abandonAudioFocus(audioFocusChangeListener)
        }
        System.out.println("[AudioManager] Audio focus abandoned.")
    }

    /**
     * Redirects audio routing to the Bluetooth SCO profile (Meta Ray-Bans).
     */
    public fun configureBluetoothSCO() {
        registerScoReceiver()
        
        // Priority 1: Modern setCommunicationDevice (Android 12+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val devices = androidAudioManager.availableCommunicationDevices
            val scoDevice = devices.find { 
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || 
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP 
            }
            if (scoDevice != null) {
                val result = androidAudioManager.setCommunicationDevice(scoDevice)
                System.out.println("[AudioManager] Requested communication device: ${scoDevice.productName}, Result: $result")
            }
        }
        
        // Priority 2: Classic startBluetoothSco
        System.out.println("[AudioManager] Requesting startBluetoothSco()...")
        androidAudioManager.startBluetoothSco()
        
        // Wait briefly for hardware handshake before forcing flag and mode
        mainHandler.postDelayed({
            androidAudioManager.isBluetoothScoOn = true
            androidAudioManager.mode = AndroidAudioManager.MODE_IN_CALL
            System.out.println("[AudioManager] Forced isBluetoothScoOn=true and mode=MODE_IN_CALL after delay.")
        }, 500)
    }

    /**
     * Returns a detailed report of the current audio hardware state
     */
    public fun getHardwareReport(): JSONObject {
        val report = JSONObject()
        report.put("isRecording", isRecording)
        report.put("isScoRequested", androidAudioManager.isBluetoothScoOn)
        report.put("isScoConnected", isScoConnected)
        report.put("audioMode", androidAudioManager.mode)
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val device = androidAudioManager.communicationDevice
            report.put("commDevice", device?.productName ?: "none")
            report.put("commDeviceType", device?.type ?: -1)
        }
        
        return report
    }

    /**
     * Initializes and starts recording audio at 16 kHz mono Int16, emitting 100 ms chunks
     */
    @SuppressLint("MissingPermission")
    public fun startRecording(onChunk: (ByteArray) -> Unit): Boolean {
        if (isRecording) return true
        
        if (!requestAudioFocus()) {
            System.err.println("[AudioManager] Failed to start recording: Audio focus denied by system.")
            return false
        }
        
        configureBluetoothSCO()

        val bufferSize = Math.max(
            AudioRecord.getMinBufferSize(sampleRateInput, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT),
            bytesPerChunk * 2
        )

        // Using VOICE_COMMUNICATION source to enable acoustic echo cancellation
        audioRecord = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            sampleRateInput,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferSize
        )

        val trackMinBufferSize = AudioTrack.getMinBufferSize(
            sampleRateOutput,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        // Use a larger buffer size (at least 64KB) to act as a proper jitter buffer and prevent popping/clicking from underruns.
        val trackBufferSize = Math.max(trackMinBufferSize, 64 * 1024)

        // Initialize AudioTrack for playing downstream Gemini Live audio
        @Suppress("DEPRECATION")
        audioTrack = AudioTrack(
            AndroidAudioManager.STREAM_VOICE_CALL,
            sampleRateOutput,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            trackBufferSize,
            AudioTrack.MODE_STREAM
        )

        audioRecord?.startRecording()
        audioTrack?.play()
        isRecording = true
        startPlaybackLoop()

        executorService.submit {
            val audioBuffer = ByteArray(bytesPerChunk)
            while (isRecording) {
                val readBytes = audioRecord?.read(audioBuffer, 0, bytesPerChunk) ?: -1
                if (readBytes > 0) {
                    val chunk = audioBuffer.copyOf(readBytes)
                    onChunk(chunk)
                } else if (readBytes < 0) {
                    System.err.println("[AudioManager] AudioRecord read error status: $readBytes")
                    try { Thread.sleep(100) } catch (e: Exception) {}
                }
            }
        }
        return true
    }

    /**
     * Stops audio recording and playback, releasing hardware resources.
     */
    public fun stopRecording() {
        if (!isRecording) return
        isRecording = false
        
        stopPlaybackLoop()
        
        try {
            audioRecord?.stop()
            audioRecord?.release()
            audioRecord = null
            
            audioTrack?.stop()
            audioTrack?.release()
            audioTrack = null
        } catch (e: Exception) {
            System.err.println("[AudioManager] Error releasing hardware: ${e.message}")
        }
        
        androidAudioManager.isBluetoothScoOn = false
        androidAudioManager.stopBluetoothSco()
        androidAudioManager.mode = AndroidAudioManager.MODE_NORMAL
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Clearing preferred communication device
            @Suppress("UNUSED_VARIABLE")
            val cleared = androidAudioManager.clearCommunicationDevice()
        }
        
        unregisterScoReceiver()
        abandonAudioFocus()
        
        System.out.println("[AudioManager] Audio recording and playback hardware released. SCO routing disabled.")
    }

    /**
     * Enqueues binary PCM audio chunks for paced playback.
     */
    public fun playAudio(pcmChunk: ByteArray) {
        if (isRecording && isPlaybackActive) {
            audioQueue.offer(pcmChunk)
        }
    }
}
