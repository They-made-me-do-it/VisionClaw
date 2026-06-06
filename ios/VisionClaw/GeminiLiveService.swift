// GeminiLiveService.swift
// VisionClaw
// Bidirectional Gemini Live API Client using WSS

import Foundation

public final class GeminiLiveService: NSObject {
    public static let shared = GeminiLiveService()
    
    private var webSocketTask: URLSessionWebSocketTask?
    private let urlSession = URLSession(configuration: .default)
    
    // Resumption token to restore context when 10-minute network connection resets
    private var lastResumptionToken: String?
    
    // Circuit Breaker state for OpenClaw tool calls to prevent infinite failure loops
    private var consecutiveFailures = 0
    private let failureThreshold = 3
    private var circuitTripped = false
    private var circuitTrippedTime: Date?
    private let circuitCooldownInterval: TimeInterval = 60.0 // 1 minute cooldown
    
    private override init() {
        super.init()
    }
    
    /// Establishes the WebSocket connection to Gemini Live API
    public func connect(apiKey: String) {
        let urlString = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=\(apiKey)"
        guard let url = URL(string: urlString) else { return }
        
        webSocketTask = urlSession.webSocketTask(with: url)
        webSocketTask?.resume()
        
        print("[GeminiLiveService] WebSocket connection initiated.")
        
        // 1. Send Setup Configuration Payload
        sendSetupMessage()
        
        // 2. Start receiving server messages
        receiveMessages()
    }
    
    /// Sends the initial BidiGenerateContentSetup payload to initialize the model
    private func sendSetupMessage() {
        var setupPayload: [String: Any] = [
            "setup": [
                "model": "models/gemini-live-2.5-flash-native-audio",
                "generationConfig": [
                    "responseModalities": ["AUDIO"],
                    "speechConfig": [
                        "voiceConfig": [
                            "prebuiltVoiceConfig": [
                                "voiceName": "Puck"
                            ]
                        ]
                    ]
                ],
                // Context window compression configuration to survive multimedia session limits
                "contextWindowCompression": [
                    "slidingWindow": [
                        "windowSizeLimit": 2000
                    ]
                ],
                // OpenClaw execution tool registration
                "tools": [
                    [
                        "functionDeclarations": [
                            [
                                "name": "execute",
                                "description": "Execute local tool action via the OpenClaw Gateway on the LAN",
                                "behavior": "NON_BLOCKING", // Enable async conversation continuation
                                "scheduling": "INTERRUPT",   // Interrupt the model stream if required
                                "parameters": [
                                    "type": "OBJECT",
                                    "properties": [
                                        "toolName": ["type": "STRING", "description": "The target tool name to run, e.g., capture_photo"],
                                        "arguments": ["type": "OBJECT", "description": "JSON arguments matching tool spec"]
                                    ],
                                    "required": ["toolName"]
                                ]
                            ]
                        ]
                    ]
                ]
            ]
        ]
        
        // If we have a resumption token from a previous connection, include it to restore context
        if let token = lastResumptionToken {
            print("[GeminiLiveService] Resuming session with token: \(token.prefix(8))...")
            var setupDict = setupPayload["setup"] as? [String: Any] ?? [:]
            setupDict["resumptionToken"] = token
            setupPayload["setup"] = setupDict
        }
        
        sendJSON(setupPayload)
    }
    
    /// Periodically processes incoming responses from the WSS endpoint
    private func receiveMessages() {
        webSocketTask?.receive { [weak self] result in
            guard let self = self else { return }
            
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleServerJSON(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleServerJSON(text)
                    }
                @unknown default:
                    break
                }
                
                // Keep listening
                self.receiveMessages()
                
            case .failure(let error):
                print("[GeminiLiveService] WebSocket error or disconnect: \(error.localizedDescription)")
                self.handleDisconnect()
            }
        }
    }
    
    /// Parses the JSON BidiGenerateContentServerMessage schema
    private func handleServerJSON(_ jsonString: String) {
        guard let data = jsonString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }
        
        // 1. Audio stream chunks (Gemini -> App -> Glasses)
        if let serverContent = json["serverContent"] as? [String: Any],
           let parts = serverContent["parts"] as? [[String: Any]] {
            for part in parts {
                if let inlineData = part["inlineData"] as? [String: Any],
                   let mimeType = inlineData["mimeType"] as? String,
                   mimeType.contains("audio/pcm"),
                   let base64Audio = inlineData["data"] as? String,
                   let audioData = Data(base64Encoded: base64Audio) {
                    // Playback the downstream chunks (24 kHz mono Int16 Little Endian)
                    AudioManager.shared.playAudio(chunk: audioData)
                }
            }
        }
        
        // 2. Session Resumption Token updates
        if let sessionUpdate = json["sessionResumptionUpdate"] as? [String: Any],
           let token = sessionUpdate["resumptionToken"] as? String {
            self.lastResumptionToken = token
            print("[GeminiLiveService] Cached session resumption token: \(token.prefix(10))...")
        }
        
        // 3. Tool Calls (Gemini -> App -> OpenClaw Gateway)
        if let toolCall = json["toolCall"] as? [String: Any],
           let functionCalls = toolCall["functionCalls"] as? [[String: Any]] {
            for functionCall in functionCalls {
                if let name = functionCall["name"] as? String,
                   name == "execute",
                   let args = functionCall["args"] as? [String: Any],
                   let callId = functionCall["id"] as? String {
                    self.dispatchToolCall(args: args, callId: callId)
                }
            }
        }
    }
    
    /// Dispatch tool calls to OpenClaw Tool Router with Circuit Breaker protection
    private func dispatchToolCall(args: [String: Any], callId: String) {
        // Evaluate circuit breaker status
        if circuitTripped {
            if let tripTime = circuitTrippedTime, Date().timeIntervalSince(tripTime) > circuitCooldownInterval {
                // Cooldown completed: reset circuit
                circuitTripped = false
                consecutiveFailures = 0
                print("[GeminiLiveService] Circuit breaker cooldown complete. Resetting breaker.")
            } else {
                print("[GeminiLiveService] Tool call blocked. Circuit is TRIPPED.")
                sendToolResponse(callId: callId, errorMsg: "Tool execution blocked: Local OpenClaw circuit breaker is tripped.")
                return
            }
        }
        
        OpenClawToolRouter.shared.routeToolCall(args: args) { [weak self] success, resultString in
            guard let self = self else { return }
            
            if success {
                self.consecutiveFailures = 0
                self.sendToolResponse(callId: callId, successPayload: ["result": resultString])
            } else {
                self.consecutiveFailures += 1
                print("[GeminiLiveService] Tool execution failure count: \(self.consecutiveFailures)")
                
                if self.consecutiveFailures >= self.failureThreshold {
                    self.circuitTripped = true
                    self.circuitTrippedTime = Date()
                    print("[GeminiLiveService] WARNING: Circuit breaker tripped! Halting further OpenClaw queries.")
                }
                
                self.sendToolResponse(callId: callId, errorMsg: resultString)
            }
        }
    }
    
    /// Sends tool execution result back to Gemini Live WebSocket
    private func sendToolResponse(callId: String, successPayload: [String: Any]? = nil, errorMsg: String? = nil) {
        var functionResponse: [String: Any] = [
            "id": callId,
            "name": "execute"
        ]
        
        if let error = errorMsg {
            functionResponse["response"] = ["error": error]
        } else if let payload = successPayload {
            functionResponse["response"] = payload
        }
        
        let clientMessage: [String: Any] = [
            "toolResponse": [
                "functionResponses": [functionResponse]
            ]
        ]
        
        sendJSON(clientMessage)
    }
    
    /// Sends Base64 audio/video inputs upstream
    public func sendMediaChunk(mimeType: String, base64Data: String) {
        let mediaPayload: [String: Any] = [
            "realtimeInput": [
                "mediaChunks": [
                    [
                        "mimeType": mimeType,
                        "data": base64Data
                    ]
                ]
            ]
        ]
        sendJSON(mediaPayload)
    }
    
    private func sendJSON(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let jsonString = String(data: data, encoding: .utf8) else {
            return
        }
        
        webSocketTask?.send(.string(jsonString)) { error in
            if let error = error {
                print("[GeminiLiveService] Send error: \(error.localizedDescription)")
            }
        }
    }
    
    private func handleDisconnect() {
        // Implement auto-reconnection with exponential backoff if required.
        // It will automatically use the stored lastResumptionToken on the next setup.
    }
}
