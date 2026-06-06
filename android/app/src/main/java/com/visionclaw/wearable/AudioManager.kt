// AudioManager.kt
// VisionClaw
// Android hardware audio stream manager for capturing and playing bluetooth streams

package com.visionclaw.wearable

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager as AndroidAudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

public class AudioManager(private val context: Context) {
    private val androidAudioManager = context.getSystemService(Context.AUDIO_SERVICE) as AndroidAudioManager
    private val executorService: ExecutorService = Executors.newSingleThreadExecutor()
    
    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null
    private var isRecording = false
    
    // Config: 100 ms chunks at 16 kHz Mono Int16 = 1600 samples = 3200 bytes
    private val sampleRateInput = 16000
    private val bytesPerChunk = 3200 
    
    // Config: 24 kHz Mono Int16 Output
    private val sampleRateOutput = 24000

    private var focusRequest: Any? = null

    private val audioFocusChangeListener = AndroidAudioManager.OnAudioFocusChangeListener { focusChange ->
        when (focusChange) {
            AndroidAudioManager.AUDIOFOCUS_LOSS,
            AndroidAudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                System.out.println("[AudioManager] Audio focus lost, stopping capture.")
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
        androidAudioManager.startBluetoothSco()
        androidAudioManager.isBluetoothScoOn = true
        androidAudioManager.mode = AndroidAudioManager.MODE_IN_COMMUNICATION
        System.out.println("[AudioManager] Bluetooth SCO audio routing requested and set to MODE_IN_COMMUNICATION.")
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

        val trackBufferSize = AudioTrack.getMinBufferSize(
            sampleRateOutput,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )

        // Initialize AudioTrack for playing downstream Gemini Live audio
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

        executorService.submit {
            val audioBuffer = ByteArray(bytesPerChunk)
            while (isRecording) {
                val readBytes = audioRecord?.read(audioBuffer, 0, bytesPerChunk) ?: -1
                if (readBytes > 0) {
                    val chunk = audioBuffer.copyOf(readBytes)
                    onChunk(chunk)
                }
            }
        }
        System.out.println("[AudioManager] Audio capture and playback loops initialized.")
        return true
    }

    /**
     * Stops audio capturing and releases hardware resources.
     */
    public fun stopRecording() {
        if (!isRecording) return
        isRecording = false
        
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        
        audioTrack?.stop()
        audioTrack?.release()
        audioTrack = null
        
        androidAudioManager.stopBluetoothSco()
        androidAudioManager.mode = AndroidAudioManager.MODE_NORMAL
        abandonAudioFocus()
        
        System.out.println("[AudioManager] Audio recording and playback hardware released.")
    }

    /**
     * Plays 24 kHz 16-bit little-endian monaural PCM chunks arriving from the Gemini Live server
     */
    public fun playAudio(chunk: ByteArray) {
        audioTrack?.let { track ->
            if (track.playState == AudioTrack.PLAYSTATE_PLAYING) {
                track.write(chunk, 0, chunk.size)
            }
        }
    }
}
