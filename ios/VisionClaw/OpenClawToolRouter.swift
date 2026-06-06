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
    
    private init() {}
    
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
        let urlString = "http://\(gatewayIP):\(gatewayPort)/tools/invoke"
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
        request.httpMethod = "POST"
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
                completion(false, "Gateway returned error status code: \(httpResponse.statusCode)")
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
        print("[OpenClawToolRouter] Initiating async capture_photo operation...")
        
        // In a real device environment, this captures a snapshot from the video frame pool or triggers
        // the high-resolution DAT camera capture. Here we simulate the capture of a 1080p frame.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            
            // 1. Generate Mock image byte data (e.g. solid white JPEG or last cached frame)
            let mockImage = UIImage(systemName: "camera.fill") ?? UIImage()
            guard let imageData = mockImage.jpegData(compressionQuality: 0.8) else {
                completion(false, "Failed to encode captured image.")
                return
            }
            
            // 2. Perform Async upload to OpenClaw hosting machine's workspace
            let uploadUrlString = "http://\(self.gatewayIP):\(self.gatewayPort)/workspace/upload"
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
            let filename = "capture_\(Int(Date().timeIntervalSince1970)).jpg"
            
            // Append metadata/destination file path (~/.openclaw/workspace/)
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"destinationPath\"\r\n\r\n".data(using: .utf8)!)
            body.append("~/.openclaw/workspace/\(filename)\r\n".data(using: .utf8)!)
            
            // Append file data
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
            body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
            body.append(imageData)
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
                
                let workspacePath = "~/.openclaw/workspace/\(filename)"
                print("[OpenClawToolRouter] Photo successfully uploaded to OpenClaw workspace: \(workspacePath)")
                completion(true, "Photo successfully saved to OpenClaw workspace: \(workspacePath)")
            }
            task.resume()
        }
    }
}
