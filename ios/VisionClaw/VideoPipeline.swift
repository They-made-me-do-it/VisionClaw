// VideoPipeline.swift
// VisionClaw
// Core video capture, frame processing, compression, and throttling pipeline

import Foundation
import UIKit
import CoreMedia

// Target Meta Wearables DAT SDK 0.7.0 for iOS 26+
// Resolves low-level IPC starting/stopping loops.
public enum DATResolution {
    case low
    case medium // 504x896
    case high
}

public struct DATStreamConfiguration {
    public let resolution: DATResolution
    public let targetFrameRate: Int
}

public class DATDeviceSession {
    public func stop() {
        print("[DATDeviceSession] Stopping wearable hardware session proactively to free broadcast slot.")
    }
}

public class DATVideoStream {
    public func stop() {
        print("[DATVideoStream] Stopping video stream proactively.")
    }
}

public protocol MWDatVideoStreamDelegate: AnyObject {
    func videoStream(_ stream: Any, didReceive frame: CMSampleBuffer)
}

public final class VideoPipeline: NSObject, MWDatVideoStreamDelegate {
    public static let shared = VideoPipeline()
    
    // Configured directly for 504x896 resolution and a lower target frame rate (1 fps) at initialization
    // to prevent local Bluetooth Classic link bandwidth overload and package drops.
    private let streamConfig = DATStreamConfiguration(resolution: .medium, targetFrameRate: 1)
    
    // Active SDK 0.7.0 references for strict lifecycle management
    private var activeSession: DATDeviceSession?
    private var activeStream: DATVideoStream?
    
    // Throttling State
    private var lastSentFrameTime: Date = .distantPast
    private let throttleInterval: TimeInterval = 1.0 // 1 fps
    
    // In-flight transmission check to prevent network backlog and memory leaks
    private var isFrameInFlight = false
    
    // Callback to send the Base64 JPEG frame payload upstream
    public var onFrameProcessed: ((String) -> Void)?
    
    private override init() {
        super.init()
    }
    
    /// Initializes connection with the Meta DAT Wearable device (0.7.0)
    public func initializeDATStream(session: DATDeviceSession, stream: DATVideoStream) {
        self.activeSession = session
        self.activeStream = stream
        print("[VideoPipeline] Initializing DAT stream at resolution 504x896 and 1 fps (Low Frame Rate).")
    }
    
    /// Strict session lifecycle hygiene to release the Bluetooth broadcast slot when backgrounded or terminated
    public func stopSessionProactively() {
        print("[VideoPipeline] App entered background or terminating: Awaiting stream and session shutdown...")
        activeStream?.stop()
        activeSession?.stop()
        activeStream = nil
        activeSession = nil
    }
    
    /// Delegate callback receiving video frames from the Meta glasses (nominally 1-fps target)
    public func videoStream(_ stream: Any, didReceive frame: CMSampleBuffer) {
        let now = Date()
        
        // 1. Frame-rate Throttling: Check if at least 1 second has elapsed since the last dispatched frame
        guard now.timeIntervalSince(lastSentFrameTime) >= throttleInterval else {
            // Drop frame if we are within the 1-second interval
            return
        }
        
        // 2. In-flight Guard: Forcefully skip sending new frames if the previous one hasn't finished uploading
        guard !isFrameInFlight else {
            print("[VideoPipeline] Upstream transfer busy: forcefully skipping frame to prevent thread and link congestion.")
            return
        }
        
        // Set in-flight flag
        isFrameInFlight = true
        
        // Process the frame on a background thread to prevent blocking the SDK capture queue
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            
            guard let image = self.imageFromSampleBuffer(frame) else {
                self.isFrameInFlight = false
                return
            }
            
            // 3. Compress to JPEG at 50% quality to reduce bluetooth bandwidth
            guard let jpegData = image.jpegData(compressionQuality: 0.5) else {
                print("[VideoPipeline] Failed to compress frame to JPEG.")
                self.isFrameInFlight = false
                return
            }
            
            // 4. Base64 Encode the compressed frame
            let base64String = jpegData.base64EncodedString()
            
            // Dispatch the payload upstream
            self.lastSentFrameTime = Date()
            self.onFrameProcessed?(base64String)
            
            // Reset the in-flight guard
            self.isFrameInFlight = false
        }
    }
    
    /// Converts a CMSampleBuffer received from the glasses to a UIImage for compression
    private func imageFromSampleBuffer(_ sampleBuffer: CMSampleBuffer) -> UIImage? {
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        let ciImage = CIImage(cvPixelBuffer: imageBuffer)
        let context = CIContext()
        guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}
