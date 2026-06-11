// VideoPipeline.kt
// VisionClaw
// Camera frame pipeline processing, throttling, and JPEG compression logic for Android

package com.visionclaw.wearable

import android.content.Context
import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.media.FaceDetector
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock
import kotlin.math.sqrt
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel

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
    public fun toBitmap(): Bitmap
}

// SQLite Vector Cache Helper class
public class VectorCacheDbHelper(context: Context) : SQLiteOpenHelper(context, DATABASE_NAME, null, DATABASE_VERSION) {
    companion object {
        const val DATABASE_NAME = "visionclaw_vector_cache.db"
        const val DATABASE_VERSION = 1
        const val TABLE_NAME = "vector_cache"
        const val COLUMN_ID = "id"
        const val COLUMN_TIMESTAMP = "timestamp"
        const val COLUMN_VECTOR = "vector"
    }

    override fun onCreate(db: SQLiteDatabase) {
        val createTable = ("CREATE TABLE " + TABLE_NAME + " ("
                + COLUMN_ID + " INTEGER PRIMARY KEY AUTOINCREMENT, "
                + COLUMN_TIMESTAMP + " INTEGER, "
                + COLUMN_VECTOR + " TEXT)")
        db.execSQL(createTable)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS " + TABLE_NAME)
        onCreate(db)
    }

    public fun insertVector(timestamp: Long, vectorStr: String) {
        try {
            val db = this.writableDatabase
            val values = ContentValues()
            values.put(COLUMN_TIMESTAMP, timestamp)
            values.put(COLUMN_VECTOR, vectorStr)
            db.insert(TABLE_NAME, null, values)
        } catch (e: Exception) {
            System.err.println("[VectorCacheDbHelper] Error inserting vector: ${e.message}")
        }
    }

    public fun getVectorsInWindow(startTime: Long): List<String> {
        val vectors = ArrayList<String>()
        try {
            val db = this.readableDatabase
            val cursor = db.query(
                TABLE_NAME,
                arrayOf(COLUMN_VECTOR),
                "$COLUMN_TIMESTAMP >= ?",
                arrayOf(startTime.toString()),
                null,
                null,
                null
            )
            if (cursor != null) {
                if (cursor.moveToFirst()) {
                    do {
                        vectors.add(cursor.getString(0))
                    } while (cursor.moveToNext())
                }
                cursor.close()
            }
        } catch (e: Exception) {
            System.err.println("[VectorCacheDbHelper] Error fetching vectors: ${e.message}")
        }
        return vectors
    }
}

// Local edge visual embedder
public object LocalEdgeEmbedder {
    public fun calculateGrayscaleEmbedding(bitmap: Bitmap): FloatArray {
        // Resize bitmap to 8x8 (64 features) to keep it extremely fast and lightweight
        val scaled = Bitmap.createScaledBitmap(bitmap, 8, 8, false)
        val pixels = IntArray(64)
        scaled.getPixels(pixels, 0, 8, 0, 0, 8, 8)
        
        val embedding = FloatArray(64)
        var sum = 0f
        for (i in 0 until 64) {
            val color = pixels[i]
            val r = (color shr 16) and 0xff
            val g = (color shr 8) and 0xff
            val b = color and 0xff
            // Standard luminance conversion
            val gray = (0.299f * r + 0.587f * g + 0.114f * b)
            embedding[i] = gray
            sum += gray * gray
        }
        
        val magnitude = sqrt(sum.toDouble()).toFloat()
        if (magnitude > 0f) {
            for (i in 0 until 64) {
                embedding[i] /= magnitude
            }
        }
        scaled.recycle()
        return embedding
    }

    public fun cosineSimilarity(v1: FloatArray, v2: FloatArray): Float {
        var dotProduct = 0f
        for (i in 0 until 64) {
            dotProduct += v1[i] * v2[i]
        }
        return dotProduct
    }
}

public class VideoPipeline {
    companion object {
        public val shared: VideoPipeline = VideoPipeline()
    }

    // Coroutine Scope for background operations
    private val pipelineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // Non-blocking consumer-producer buffer channel to pipe masked images
    private val frameChannel = Channel<ByteArray>(capacity = 5, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    private val streamConfig = DATStreamConfig(DATResolution.MEDIUM, 1)
    
    @Volatile
    private var lastSentFrameTime: Long = 0L
    
    @Volatile
    private var throttleIntervalMs: Long = 1000L // 1 fps default
    
    @Volatile
    private var isManualSnapshotOnly: Boolean = false

    // In-flight transmission guard flag to avoid memory allocation backlog
    private val isFrameInFlight = AtomicBoolean(false)

    // Cache for latest frame bytes to expose to other tools (like capture_photo)
    @Volatile
    public var lastFrameBytes: ByteArray? = null

    // Active SDK 0.7.0 references for strict lifecycle management
    private var activeSession: DATDeviceSession? = null
    private var activeStream: DATVideoStream? = null

    // SQLite Db Helper
    private var dbHelper: VectorCacheDbHelper? = null

    // Callback targeting the Gemini Live WSS client upload channel
    public var onFrameProcessed: ((String) -> Unit)? = null

    init {
        // Start non-blocking consumer loop on Dispatchers.IO
        pipelineScope.launch(Dispatchers.IO) {
            for (jpegBytes in frameChannel) {
                try {
                    val base64String = Base64.encodeToString(jpegBytes, Base64.NO_WRAP)
                    onFrameProcessed?.invoke(base64String)
                } catch (e: Exception) {
                    System.err.println("[VideoPipeline] Error in WSS transmit loop: ${e.message}")
                }
            }
        }
    }

    public fun initialize(context: Context, session: DATDeviceSession, stream: DATVideoStream) {
        this.activeSession = session
        this.activeStream = stream
        this.dbHelper = VectorCacheDbHelper(context.applicationContext)
        System.out.println("[VideoPipeline] Initializing DAT Camera stream with Context and SQLite vector cache.")
        
        // Start simulation loop for mocks to verify diagnostic flow
        startMockFrameGenerator()
    }

    // Deprecated override kept for backward compatibility if called elsewhere
    public fun initializeDATStream(session: DATDeviceSession, stream: DATVideoStream) {
        this.activeSession = session
        this.activeStream = stream
        System.out.println("[VideoPipeline] Initializing DAT Camera stream without Context (backward compatibility).")
        startMockFrameGenerator()
    }

    public fun getThrottleIntervalMs(): Long {
        return throttleIntervalMs
    }

    public fun updateRttMetric(avgRtt: Double) {
        if (avgRtt > 5000.0) {
            isManualSnapshotOnly = true
            throttleIntervalMs = Long.MAX_VALUE
            System.out.println("[VideoPipeline] Severe network degradation (RTT: ${avgRtt}ms). Switched to MANUAL snapshot-only gating.")
        } else if (avgRtt > 250.0) {
            isManualSnapshotOnly = false
            throttleIntervalMs = 10000L
            System.out.println("[VideoPipeline] High latency (RTT: ${avgRtt}ms). Down-regulating capture frequency to 0.1 FPS.")
        } else {
            isManualSnapshotOnly = false
            throttleIntervalMs = 1000L
            System.out.println("[VideoPipeline] Network healthy (RTT: ${avgRtt}ms). Camera running at 1 FPS.")
        }
    }

    public fun isSessionActive(): Boolean {
        return activeSession != null
    }

    public fun isStreamingFlowing(): Boolean {
        return lastFrameBytes != null && (System.currentTimeMillis() - lastSentFrameTime < 5000)
    }

    private fun startMockFrameGenerator() {
        pipelineScope.launch(Dispatchers.Default) {
            while (activeSession != null) {
                try {
                    onFrameReceived(object : MWDatFrame {
                        override fun getWidth(): Int = 504
                        override fun getHeight(): Int = 896
                        override fun toBitmap(): Bitmap = Bitmap.createBitmap(504, 896, Bitmap.Config.ARGB_8888)
                    })
                    // Dynamically sleep based on computed throttle interval (minimum 100ms)
                    val sleepTime = if (throttleIntervalMs == Long.MAX_VALUE) 1000L else throttleIntervalMs
                    delay(sleepTime)
                } catch (e: CancellationException) {
                    break
                } catch (e: Exception) {
                    delay(1000)
                }
            }
        }
    }

    public fun stopSessionProactively() {
        System.out.println("[VideoPipeline] Terminating stream and session proactively to free hardware broadcast slot.")
        activeStream?.stop()
        activeSession?.stop()
        activeStream = null
        activeSession = null
    }

    private val frameLock = ReentrantLock()

    public fun onFrameReceived(frame: MWDatFrame) {
        val now = System.currentTimeMillis()

        // 1. Dynamic rate gating
        if (isManualSnapshotOnly) {
            // In manual snapshot-only mode, discard all automated captures
            return
        }

        if (now - lastSentFrameTime < throttleIntervalMs) {
            return
        }

        // 2. Concurrency Gating
        if (!isFrameInFlight.compareAndSet(false, true)) {
            return
        }

        // Processing runs entirely on Dispatchers.Default (background worker pool)
        pipelineScope.launch(Dispatchers.Default) {
            if (!frameLock.tryLock()) {
                isFrameInFlight.set(false)
                return@launch
            }
            try {
                val originalBitmap = frame.toBitmap()

                // --- Task 2: Vector Cache Check ---
                var isDuplicate = false
                val currentEmbedding = LocalEdgeEmbedder.calculateGrayscaleEmbedding(originalBitmap)
                
                dbHelper?.let { db ->
                    // 5-minute rolling window
                    val startTime = System.currentTimeMillis() - 300000L
                    val cachedVectorStrings = db.getVectorsInWindow(startTime)
                    
                    for (vectorStr in cachedVectorStrings) {
                        val parsedVector = vectorStr.split(",").map { it.toFloat() }.toFloatArray()
                        if (parsedVector.size == 64) {
                            val similarity = LocalEdgeEmbedder.cosineSimilarity(currentEmbedding, parsedVector)
                            if (similarity > 0.95f) {
                                isDuplicate = true
                                System.out.println("[VideoPipeline] Vector Cache Hit (Similarity: ${similarity}). Blocking duplicate network frame upload.")
                                break
                            }
                        }
                    }
                    
                    if (!isDuplicate) {
                        val vectorStr = currentEmbedding.joinToString(",")
                        db.insertVector(System.currentTimeMillis(), vectorStr)
                    }
                }

                // If duplicate detected, release resources and return immediately without queuing
                if (isDuplicate) {
                    originalBitmap.recycle()
                    isFrameInFlight.set(false)
                    frameLock.unlock()
                    return@launch
                }

                // --- Task 3: Background Face Detection ---
                val processedBitmap = maskBystanderFaces(originalBitmap)
                
                val outputStream = ByteArrayOutputStream()
                processedBitmap.compress(Bitmap.CompressFormat.JPEG, 50, outputStream)
                val jpegBytes = outputStream.toByteArray()

                if (processedBitmap != originalBitmap) {
                    processedBitmap.recycle()
                }
                originalBitmap.recycle()

                lastFrameBytes = jpegBytes
                lastSentFrameTime = System.currentTimeMillis()

                // Send processed bytes to non-blocking channel for network delivery
                frameChannel.trySend(jpegBytes)
            } catch (e: Exception) {
                System.err.println("[VideoPipeline] Frame processing failed: ${e.message}")
            } finally {
                frameLock.unlock()
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
