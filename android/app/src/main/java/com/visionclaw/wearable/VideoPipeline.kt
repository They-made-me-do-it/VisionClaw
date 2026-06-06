// VideoPipeline.kt
// VisionClaw
// Camera frame pipeline processing, throttling, and JPEG compression logic for Android

package com.visionclaw.wearable

import android.graphics.Bitmap
import android.graphics.Matrix
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

// Mock representation of the Meta Wearables Device Access Toolkit (DAT) SDK Classes
public enum class DATResolution {
    LOW,
    MEDIUM, // 504x896
    HIGH
}

public class DATStreamConfig(
    public val resolution: DATResolution,
    public val targetFps: Int
)

public class DATDeviceSession {
    public fun stop() {
        System.out.println("[DATDeviceSession] Stopping wearable hardware session proactively to free broadcast slot.")
    }
}

public class DATVideoStream {
    public fun stop() {
        System.out.println("[DATVideoStream] Stopping video stream proactively.")
    }
}

public interface MWDatFrame {
    public fun getWidth(): Int
    public fun getHeight(): Int
    // Returns frame as raw RGB/YUV data, or converted to a Bitmap
    public fun toBitmap(): Bitmap
}

public class VideoPipeline {
    companion object {
        public val shared: VideoPipeline = VideoPipeline()
    }

    // Configured directly for 504x896 Medium Resolution and 1 fps target frame rate at initialization
    // to prevent local Bluetooth Classic link bandwidth overload and package drops.
    private val streamConfig = DATStreamConfig(DATResolution.MEDIUM, 1)
    
    private val executorService: ExecutorService = Executors.newFixedThreadPool(2)
    private var lastSentFrameTime: Long = 0L
    private val throttleIntervalMs: Long = 1000L // 1 fps
    
    // In-flight transmission guard flag to avoid memory allocation backlog
    @Volatile
    private var isFrameInFlight = false

    // Cache for latest frame bytes to expose to other tools (like capture_photo)
    @Volatile
    public var lastFrameBytes: ByteArray? = null

    // Active SDK 0.7.0 references for strict lifecycle management
    private var activeSession: DATDeviceSession? = null
    private var activeStream: DATVideoStream? = null

    // Callback targeting the Gemini Live WSS client upload channel
    public var onFrameProcessed: ((String) -> Unit)? = null

    /**
     * Connects to the DAT wearable camera pipeline (SDK 0.7.0)
     */
    public fun initializeDATStream(session: DATDeviceSession, stream: DATVideoStream) {
        this.activeSession = session
        this.activeStream = stream
        System.out.println("[VideoPipeline] Initializing DAT Camera stream at resolution 504x896 (Medium) and 1 fps target directly at hardware configuration.")
    }

    /**
     * Strict wearable broadcast session hygiene: stops stream and session proactively to unlock broadcast slot
     */
    public fun stopSessionProactively() {
        System.out.println("[VideoPipeline] Terminating stream and session proactively to free hardware broadcast slot.")
        activeStream?.stop()
        activeSession?.stop()
        activeStream = null
        activeSession = null
    }

    /**
     * Main callback triggered by the DAT SDK when a camera frame is ready (nominally 24-fps)
     */
    public fun onFrameReceived(frame: MWDatFrame) {
        val now = System.currentTimeMillis()

        // 1. Throttle to 1 fps
        if (now - lastSentFrameTime < throttleIntervalMs) {
            return
        }

        // 2. In-flight Guard check: Forcefully skip sending new frames if previous hasn't finished uploading
        if (isFrameInFlight) {
            System.out.println("[VideoPipeline] Upstream thread busy: forcefully dropping frame to prevent thread and link congestion.")
            return
        }

        isFrameInFlight = true

        executorService.submit {
            try {
                // Convert frame representation to Android Bitmap
                val bitmap = frame.toBitmap()
                
                // Scale if necessary, but DAT is initialized at 504x896 natively
                // 3. Compress to JPEG (50% quality)
                val outputStream = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.JPEG, 50, outputStream)
                val jpegBytes = outputStream.toByteArray()

                // Cache the real frame bytes for downstream photo-capture tools
                lastFrameBytes = jpegBytes

                // 4. Base64 Encode JPEG binary data without line wraps
                val base64String = Base64.encodeToString(jpegBytes, Base64.NO_WRAP)

                // Dispatch frame upstream to Gemini WSS client
                lastSentFrameTime = System.currentTimeMillis()
                onFrameProcessed?.invoke(base64String)
            } catch (e: Exception) {
                System.err.println("[VideoPipeline] Failed to process frame: ${e.message}")
            } finally {
                // Unlock in-flight check
                isFrameInFlight = false
            }
        }
    }
}
