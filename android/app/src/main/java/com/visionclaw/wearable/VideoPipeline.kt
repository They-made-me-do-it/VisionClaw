// VideoPipeline.kt
// VisionClaw
// Camera frame pipeline processing, throttling, and JPEG compression logic for Android

package com.visionclaw.wearable

import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.Canvas
import android.graphics.Rect
import android.media.FaceDetector
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock

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
    private val isFrameInFlight = AtomicBoolean(false)

    // Cache for latest frame bytes to expose to other tools (like capture_photo)
    @Volatile
    public var lastFrameBytes: ByteArray? = null

    // Active SDK 0.7.0 references for strict lifecycle management
    private var activeSession: DATDeviceSession? = null
    private var activeStream: DATVideoStream? = null

    // Callback targeting the Gemini Live WSS client upload channel
    public var onFrameProcessed: ((String) -> Unit)? = null

    /**
     * Checks if a hardware device session is currently active
     */
    public fun isSessionActive(): Boolean {
        return activeSession != null
    }

    /**
     * Checks if frames are currently flowing from the hardware
     */
    public fun isStreamingFlowing(): Boolean {
        return lastFrameBytes != null && (System.currentTimeMillis() - lastSentFrameTime < 5000)
    }

    /**
     * Connects to the DAT wearable camera pipeline (SDK 0.7.0)
     */
    public fun initializeDATStream(session: DATDeviceSession, stream: DATVideoStream) {
        this.activeSession = session
        this.activeStream = stream
        System.out.println("[VideoPipeline] Initializing DAT Camera stream at resolution 504x896 (Medium) and 1 fps target directly at hardware configuration.")
        
        // Start simulation loop for mocks to verify diagnostic flow
        startMockFrameGenerator()
    }

    private fun startMockFrameGenerator() {
        executorService.submit {
            while (activeSession != null) {
                onFrameReceived(object : MWDatFrame {
                    override fun getWidth(): Int = 504
                    override fun getHeight(): Int = 896
                    override fun toBitmap(): Bitmap = Bitmap.createBitmap(504, 896, Bitmap.Config.ARGB_8888)
                })
                Thread.sleep(1000)
            }
        }
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
    private val frameLock = ReentrantLock()

    public fun onFrameReceived(frame: MWDatFrame) {
        val now = System.currentTimeMillis()

        // 1. Throttle to 1 fps
        if (now - lastSentFrameTime < throttleIntervalMs) {
            return
        }

        // 2. Concurrency Gating via AtomicBoolean isFrameInFlight
        if (!isFrameInFlight.compareAndSet(false, true)) {
            System.out.println("[VideoPipeline] Upstream thread busy: forcefully dropping frame to prevent thread and link congestion.")
            return
        }

        executorService.submit {
            // Deploy mutex barrier to ensure thread-safe frame access
            if (!frameLock.tryLock()) {
                isFrameInFlight.set(false)
                return@submit
            }
            try {
                // Convert frame representation to Android Bitmap
                val originalBitmap = frame.toBitmap()
                
                // Deploy egocentric face tracking security mask at edge
                val processedBitmap = maskBystanderFaces(originalBitmap)
                
                // 3. Compress to JPEG (50% quality)
                val outputStream = ByteArrayOutputStream()
                processedBitmap.compress(Bitmap.CompressFormat.JPEG, 50, outputStream)
                val jpegBytes = outputStream.toByteArray()

                // Recycle processedBitmap if copy was created
                if (processedBitmap != originalBitmap) {
                    processedBitmap.recycle()
                }

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
                frameLock.unlock()
                // Unlock in-flight check
                isFrameInFlight.set(false)
            }
        }
    }

    private fun maskBystanderFaces(bitmap: Bitmap): Bitmap {
        try {
            val rgb565Bitmap = bitmap.copy(Bitmap.Config.RGB_565, false) ?: return bitmap
            val maxFaces = 5
            val detector = FaceDetector(rgb565Bitmap.width, rgb565Bitmap.height, maxFaces)
            val faces = arrayOfNulls<FaceDetector.Face>(maxFaces)
            val faceCount = detector.findFaces(rgb565Bitmap, faces)

            if (faceCount > 0) {
                System.out.println("[VideoPipeline] Detected $faceCount bystander face(s) at the edge. Executing real-time pixelation mask.")
                val mutableBitmap = bitmap.copy(Bitmap.Config.ARGB_8888, true) ?: return bitmap
                val canvas = Canvas(mutableBitmap)

                // Define central visual field boundary (e.g., center 60% of the image)
                val centralWidth = bitmap.width * 0.6
                val centralHeight = bitmap.height * 0.6
                val centralLeft = (bitmap.width - centralWidth) / 2
                val centralTop = (bitmap.height - centralHeight) / 2
                val centralRight = centralLeft + centralWidth
                val centralBottom = centralTop + centralHeight
                val centralRect = Rect(centralLeft.toInt(), centralTop.toInt(), centralRight.toInt(), centralBottom.toInt())

                for (i in 0 until maxFaces) {
                    val face = faces[i] ?: continue
                    val midPoint = android.graphics.PointF()
                    face.getMidPoint(midPoint)
                    val eyesDistance = face.eyesDistance()

                    // Check if face mid-point falls within the central visual field
                    if (centralRect.contains(midPoint.x.toInt(), midPoint.y.toInt())) {
                        val faceWidth = (eyesDistance * 2.2f).toInt()
                        val faceHeight = (eyesDistance * 3.0f).toInt()
                        val left = (midPoint.x - faceWidth / 2).toInt().coerceAtLeast(0)
                        val top = (midPoint.y - faceHeight / 2).toInt().coerceAtLeast(0)
                        val right = (midPoint.x + faceWidth / 2).toInt().coerceAtMost(bitmap.width)
                        val bottom = (midPoint.y + faceHeight / 2).toInt().coerceAtMost(bitmap.height)

                        if (right > left && bottom > top) {
                            val srcRect = Rect(left, top, right, bottom)
                            val faceBmp = Bitmap.createBitmap(mutableBitmap, left, top, right - left, bottom - top)
                            
                            val pixelSize = 12
                            val widthScaled = (faceBmp.width / pixelSize).coerceAtLeast(1)
                            val heightScaled = (faceBmp.height / pixelSize).coerceAtLeast(1)
                            
                            val scaledDown = Bitmap.createScaledBitmap(faceBmp, widthScaled, heightScaled, false)
                            val pixelated = Bitmap.createScaledBitmap(scaledDown, faceBmp.width, faceBmp.height, false)
                            
                            canvas.drawBitmap(pixelated, null, srcRect, null)
                            
                            faceBmp.recycle()
                            scaledDown.recycle()
                            pixelated.recycle()
                        }
                    }
                }
                rgb565Bitmap.recycle()
                return mutableBitmap
            }
            rgb565Bitmap.recycle()
        } catch (e: Exception) {
            System.err.println("[VideoPipeline] Face masking failed: ${e.message}")
        }
        return bitmap
    }
}
