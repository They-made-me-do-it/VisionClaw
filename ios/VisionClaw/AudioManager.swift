// AudioManager.swift
// VisionClaw
// Core Audio manager pipeline for Meta Ray-Ban audio capturing and playback

import Foundation
import AVFoundation

public final class AudioManager: NSObject {
    public static let shared = AudioManager()
    
    private let audioEngine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    
    // Resampler/Converter for 16 kHz mono Int16 input
    private var inputConverter: AVAudioConverter?
    
    // Expected output audio format: 24 kHz, 16-bit, Little-Endian, Monaural PCM
    private let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                             sampleRate: 24000,
                                             channels: 1,
                                             interleaved: false)!
    
    private var isRecording = false
    private var onAudioChunk: ((Data) -> Void)?
    
    private override init() {
        super.init()
        setupAudioEngine()
    }
    
    private func setupAudioEngine() {
        audioEngine.attach(playerNode)
        audioEngine.connect(playerNode, to: audioEngine.mainMixerNode, format: outputFormat)
    }
    
    /// Configures the iOS AVAudioSession category to .videoChat to force microphone capture
    /// through the Bluetooth glasses profile, preventing ambient noise and phone mic fallbacks.
    public func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        
        // Use .videoChat category and mode with bluetooth options to route through glasses
        try session.setCategory(.videoChat,
                               mode: .videoChat,
                               options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker])
        try session.setActive(true)
        print("[AudioManager] AVAudioSession configured successfully to .videoChat category.")
    }
    
    /// Start recording microphone audio from the paired glasses.
    /// Resamples the input from native rates to 16 kHz mono PCM Int16, and packages it into 100 ms chunks.
    public func startRecording(onChunk: @escaping (Data) -> Void) throws {
        guard !isRecording else { return }
        
        try configureAudioSession()
        
        self.onAudioChunk = onChunk
        let inputNode = audioEngine.inputNode
        let nativeInputFormat = inputNode.inputFormat(forBus: 0)
        
        // Target format for Gemini Live Input: 16 kHz mono Int16 PCM
        let targetInputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                             sampleRate: 16000,
                                             channels: 1,
                                             interleaved: false)!
        
        // Set up converter from whatever native input is (e.g. 48kHz) to 16kHz
        inputConverter = AVAudioConverter(from: nativeInputFormat, to: targetInputFormat)
        
        // 100 ms chunk size at 16000 Hz is 1600 samples
        let samplesPerChunk = 1600
        var bufferAccumulator = Data()
        
        // Install tap on incoming mic stream
        inputNode.installTap(onBus: 0, bufferSize: AVAudioFrameCount(samplesPerChunk), format: nativeInputFormat) { [weak self] buffer, time in
            guard let self = self, let converter = self.inputConverter else { return }
            
            let inputRateRatio = nativeInputFormat.sampleRate / targetInputFormat.sampleRate
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) / inputRateRatio)
            
            guard let convertedBuffer = AVAudioPCMBuffer(pcmFormat: targetInputFormat, frameCapacity: capacity) else {
                return
            }
            
            var error: NSError?
            let status = converter.convert(to: convertedBuffer, error: &error) { inNumPackets, outStatus in
                outStatus.pointee = .haveData
                return buffer
            }
            
            if status == .error || error != nil {
                print("[AudioManager] Resampling error: \(error?.localizedDescription ?? "unknown")")
                return
            }
            
            // Extract Int16 samples
            guard let channelData = convertedBuffer.int16ChannelData else { return }
            let channelBytes = UnsafeRawBufferPointer(start: channelData[0], count: Int(convertedBuffer.frameLength) * 2)
            
            bufferAccumulator.append(channelBytes)
            
            // Segment into 100 ms chunks (3200 bytes per chunk at 16 kHz mono Int16)
            let bytesPerChunk = samplesPerChunk * 2
            while bufferAccumulator.count >= bytesPerChunk {
                let chunk = bufferAccumulator.prefix(bytesPerChunk)
                self.onAudioChunk?(chunk)
                bufferAccumulator.removeFirst(bytesPerChunk)
            }
        }
        
        try audioEngine.start()
        isRecording = true
        print("[AudioManager] Audio recording pipeline active.")
    }
    
    /// Stop recording audio and release tap.
    public func stopRecording() {
        guard isRecording else { return }
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        isRecording = false
        print("[AudioManager] Audio recording pipeline stopped.")
    }
    
    /// Play the downstream audio chunks arriving from the Gemini Live server
    /// Target Format: 24 kHz, 16-bit, little-endian monaural PCM
    public func playAudio(chunk: Data) {
        guard audioEngine.isRunning else {
            do {
                try audioEngine.start()
            } catch {
                print("[AudioManager] Failed to restart audio engine for playback: \(error)")
                return
            }
        }
        
        let frameCount = AVAudioFrameCount(chunk.count / 2)
        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: frameCount) else {
            return
        }
        
        pcmBuffer.frameLength = frameCount
        chunk.withUnsafeBytes { rawBuffer in
            if let dest = pcmBuffer.int16ChannelData?[0] {
                memcpy(dest, rawBuffer.baseAddress, chunk.count)
            }
        }
        
        if !playerNode.isPlaying {
            playerNode.play()
        }
        
        playerNode.scheduleBuffer(pcmBuffer, at: nil, options: [], completionHandler: nil)
    }
}
