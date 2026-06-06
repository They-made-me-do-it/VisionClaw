// AudioManager.kt
// VisionClaw
// Android hardware audio stream manager for capturing and playing bluetooth streams

package com.visionclaw.wearable

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioManager as AndroidAudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
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
    public fun startRecording(onChunk: (ByteArray) -> Unit) {
        if (isRecording) return
        configureBluetoothSCO()

        val bufferSize = Math.max(
            AudioRecord.getMinBufferSize(sampleRateInput, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT),
            bytesPerChunk * 2
        )

        audioRecord = AudioRecord(
            MediaRecorder.AudioSource.MIC,
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
    }

    /**
     * Stops audio capturing and releases hardware resources.
     */
    public fun stopRecording() {
        isRecording = false
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        
        audioTrack?.stop()
        audioTrack?.release()
        audioTrack = null
        
        androidAudioManager.stopBluetoothSco()
        androidAudioManager.mode = AndroidAudioManager.MODE_NORMAL
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
