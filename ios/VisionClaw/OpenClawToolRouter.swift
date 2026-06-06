// OpenClawToolRouter.swift
// VisionClaw
// Routes intercepted Gemini tool calls to the local OpenClaw Gateway on the LAN

import Foundation

public final class OpenClawToolRouter {
    public static let shared = OpenClawToolRouter()
    
    // Gateway settings - dynamically set via app settings UI
    public var gatewayIP: String = "192.168.1.100" // Example LAN IP
    public var gatewayPort: Int = 18789
    public var bearerToken: String = "oc_live_token_7a9c8b3d2e1f0"
    public var targetSandbox: Bool = false
    
    private var eventWebSocketTask: URLSessionWebSocketTask?
    private let urlSession = URLSession(configuration: .default)
    
    private let uploadQueue = DispatchQueue(label: "com.visionclaw.upload", qos: .background)
    private var isUploadInFlight = false
    private let lock = NSLock()
    
    private init() {}
    
    /// Connects the OpenClaw event client earlier at the beginning of the session
    public func connectEventClient() {
        guard eventWebSocketTask == nil else {
            print("[OpenClawToolRouter] Event client already connected or connecting.")
            return
        }
        
        let urlString = "ws://\(gatewayIP):\(gatewayPort)/"
        guard let url = URL(string: urlString) else { return }
        
        var request = URLRequest(url: url)
        request.setValue("localhost", forHTTPHeaderField: "Host")
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        
        eventWebSocketTask = urlSession.webSocketTask(with: request)
        eventWebSocketTask?.resume()
        print("[OpenClawToolRouter] Connecting event client to \(urlString) with Host header localhost")
        
        sendHandshakeMessage(nonce: nil)
        receiveEventMessages()
    }
    
    private func sendHandshakeMessage(nonce: String?) {
        var params: [String: Any] = [
            "role": "operator",
            "scopes": ["operator.read", "operator.write", "operator.admin"],
            "auth": ["token": bearerToken],
            "protocol": 3,
            "device": ["id": "visionclaw_ios_edge"]
        ]
        if let challengeNonce = nonce {
            params["challenge"] = challengeNonce
        }
        
        let connectMsg: [String: Any] = [
            "type": "req",
            "id": "conn_\(Int(Date().timeIntervalSince1970))",
            "method": "connect",
            "params": params
        ]
        
        guard let data = try? JSONSerialization.data(withJSONObject: connectMsg),
              let jsonString = String(data: data, encoding: .utf8) else {
            return
        }
        
        eventWebSocketTask?.send(.string(jsonString)) { error in
            if let error = error {
                print("[OpenClawToolRouter] Handshake send error: \(error.localizedDescription)")
            } else {
                print("[OpenClawToolRouter] Handshake connection frame sent (Protocol v3 + operator.admin).")
            }
        }
    }
    
    private func receiveEventMessages() {
        eventWebSocketTask?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    print("[OpenClawToolRouter] Event client received message: \(text)")
                    self.handleEventMessageJSON(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleEventMessageJSON(text)
                    }
                @unknown default:
                    break
                }
                self.receiveEventMessages()
            case .failure(let error):
                // Suppress noisy 500 logs on non-essential status items
                if error.localizedDescription.contains("500") {
                    print("[OpenClawToolRouter] Suppressed event client WSS 500 Failure.")
                } else {
                    print("[OpenClawToolRouter] Event client WSS Failure: \(error.localizedDescription)")
                }
                self.eventWebSocketTask = nil
            }
        }
    }
    
    private func handleEventMessageJSON(_ jsonString: String) {
        guard let data = jsonString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }
        
        let type = json["type"] as? String ?? ""
        let eventName = json["event"] as? String ?? ""
        
        if type == "event" && eventName == "connect.challenge" {
            if let eventData = json["data"] as? [String: Any],
               let nonce = eventData["nonce"] as? String {
                print("[OpenClawToolRouter] Received challenge nonce: \(nonce). Retrying handshake...")
                sendHandshakeMessage(nonce: nonce)
            }
        } else if json["result"] != nil {
            print("[OpenClawToolRouter] Handshake successful: hello-ok received.")
        }
    }
    
    public func disconnectEventClient() {
        eventWebSocketTask?.cancel(with: .normalClosure, reason: nil)
        eventWebSocketTask = nil
        print("[OpenClawToolRouter] Event client disconnected.")
    }
    
    /// Converts intercepted tool calls to JSON and POSTs to OpenClaw
    public func routeToolCall(args: [String: Any], completion: @escaping (Bool, String) -> Void) {
        guard let toolName = args["toolName"] as? String else {
            completion(false, "Missing toolName argument.")
            return
        }
        
        let toolArguments = args["arguments"] as? [String: Any] ?? [:]
        
        // Handle specialized tools
        if toolName == "capture_photo" {
            executeCaptureAndUploadPhoto(arguments: toolArguments, completion: completion)
            return
        }
        
        // General tool call dispatch to OpenClaw Gateway
        let isSandbox = (toolArguments["sandbox"] as? Bool ?? false) ||
                        (toolArguments["destinationPath"] as? String ?? "").lowercased().contains("sandbox") ||
                        targetSandbox
        let actualPort = isSandbox ? gatewayPort + 6 : gatewayPort
        let urlString = "http://\(gatewayIP):\(actualPort)/tools/invoke"
        guard let url = URL(string: urlString) else {
            completion(false, "Invalid URL string: \(urlString)")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        
        let payload: [String: Any] = [
            "tool": toolName,
            "arguments": toolArguments
        ]
        
        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload) else {
            completion(false, "Failed to serialize tool arguments.")
            return
        }
        request.httpBody = jsonData
        
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(false, "HTTP gateway connection error: \(error.localizedDescription)")
                return
            }
            
            guard let httpResponse = response as? HTTPURLResponse else {
                completion(false, "Invalid HTTP response.")
                return
            }
            
            guard (200...299).contains(httpResponse.statusCode) else {
                if httpResponse.statusCode == 500 {
                    print("[OpenClawToolRouter] Suppressed HTTP 500 for non-essential path: \(url.path)")
                    completion(false, "Gateway returned error status code: 500 (silent)")
                } else {
                    completion(false, "Gateway returned error status code: \(httpResponse.statusCode)")
                }
                return
            }
            
            if let data = data, let resultString = String(data: data, encoding: .utf8) {
                completion(true, resultString)
            } else {
                completion(true, "Tool execution completed successfully.")
            }
        }
        task.resume()
    }
    
    /// Executes the capture_photo tool asynchronously to prevent blocking the UI thread.
    /// Uploads the binary payload directly to the OpenClaw hosting machine's workspace (~/.openclaw/workspace).
    private func executeCaptureAndUploadPhoto(arguments: [String: Any], completion: @escaping (Bool, String) -> Void) {
        lock.lock()
        if isUploadInFlight {
            lock.unlock()
            print("[OpenClawToolRouter] Skip capture_photo: previous upload is still in-flight.")
            completion(false, "Photo upload skipped: previous upload is still in-flight.")
            return
        }
        isUploadInFlight = true
        lock.unlock()
        
        print("[OpenClawToolRouter] Initiating async capture_photo operation...")
        
        uploadQueue.async { [weak self] in
            guard let self = self else { return }
            
            defer {
                self.lock.lock()
                self.isUploadInFlight = false
                self.lock.unlock()
            }
            
            // 1. Retrieve the latest active frame bytes from the smart glasses camera stream session
            guard let imageData = VideoPipeline.shared.lastFrameBytes else {
                print("[OpenClawToolRouter] Error: No active camera stream frame captured yet.")
                completion(false, "Error: No active camera stream frame captured yet. Device is offline or has not streamed any frames.")
                return
            }
            
            // 2. Determine Sandbox offset dynamically
            let destinationPath = arguments["destinationPath"] as? String ?? "~/.openclaw/workspace/capture_\(Int(Date().timeIntervalSince1970)).jpg"
            let isSandbox = (arguments["sandbox"] as? Bool ?? false) ||
                            destinationPath.lowercased().contains("sandbox") ||
                            self.targetSandbox
            let actualPort = isSandbox ? self.gatewayPort + 6 : self.gatewayPort
            let uploadUrlString = "http://\(self.gatewayIP):\(actualPort)/workspace/upload"
            
            // 3. Save to local filesystem first to allow sync and prevent memory bloat
            var resolvedPath = destinationPath
            if destinationPath.hasPrefix("~") {
                let home = FileManager.default.homeDirectoryForCurrentUser.path
                resolvedPath = destinationPath.replacingOccurrences(of: "~", with: home)
            }
            let fileURL = URL(fileURLWithPath: resolvedPath)
            
            do {
                try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: nil)
                try imageData.write(to: fileURL)
                print("[OpenClawToolRouter] Successfully saved local photo to host path: \(fileURL.path)")
            } catch {
                print("[OpenClawToolRouter] Failed to write local copy to host path: \(error.localizedDescription)")
            }
            
            // Load from disk for upload payload to prevent excessive RAM utilization
            let uploadData = (try? Data(contentsOf: fileURL)) ?? imageData
            let filename = fileURL.lastPathComponent
            
            guard let url = URL(string: uploadUrlString) else {
                completion(false, "Invalid workspace upload URL.")
                return
            }
            
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("Bearer \(self.bearerToken)", forHTTPHeaderField: "Authorization")
            
            // Set up multi-part form data
            let boundary = "Boundary-\(UUID().uuidString)"
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            
            var body = Data()
            
            // Append metadata/destination file path (~/.openclaw/workspace/)
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"destinationPath\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(destinationPath)\r\n".data(using: .utf8)!)
            
            // Append file data
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
            body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
            body.append(uploadData)
            body.append("\r\n".data(using: .utf8)!)
            body.append("--\(boundary)--\r\n".data(using: .utf8)!)
            
            request.httpBody = body
            
            let task = URLSession.shared.dataTask(with: request) { uData, uResponse, uError in
                if let uError = uError {
                    completion(false, "Failed to upload photo to workspace: \(uError.localizedDescription)")
                    return
                }
                
                guard let httpResponse = uResponse as? HTTPURLResponse, (200...299).contains(httpResponse.statusCode) else {
                    completion(false, "Workspace upload returned status: \((uResponse as? HTTPURLResponse)?.statusCode ?? 500)")
                    return
                }
                
                print("[OpenClawToolRouter] Photo successfully uploaded to OpenClaw workspace: \(destinationPath)")
                completion(true, "Photo successfully saved to OpenClaw workspace: \(destinationPath)")
            }
            task.resume()
        }
    }
}
