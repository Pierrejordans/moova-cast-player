import Foundation
import Capacitor
import GoogleCast

@objc(CastPlayerPlugin)
public class CastPlayerPlugin: CAPPlugin, GCKDiscoveryManagerListener, GCKSessionManagerListener, GCKRemoteMediaClientListener {

    private var isInitialized = false
    private var discoveryManager: GCKDiscoveryManager?
    private var sessionManager: GCKSessionManager?
    private var currentSession: GCKCastSession?
    private var remoteMediaClient: GCKRemoteMediaClient?

    // Custom receiver App ID
    private var receiverAppId = kGCKDefaultMediaReceiverApplicationID

    // MARK: - Plugin Methods

    private func resolveReceiverAppId(_ call: CAPPluginCall) -> String? {
        if let appId = call.getString("receiverAppId")?.trimmingCharacters(in: .whitespacesAndNewlines), !appId.isEmpty {
            return appId
        }
        if let appId = getConfig().getString("receiverAppId")?.trimmingCharacters(in: .whitespacesAndNewlines), !appId.isEmpty {
            return appId
        }
        return CastPlayerBootstrap.readReceiverAppId()
    }

    @objc func initialize(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard GCKCastContext.isSharedInstanceInitialized() else {
                call.reject("Cast context not initialized. Call CastPlayerBootstrap.configure in AppDelegate.")
                return
            }

            if let appId = self.resolveReceiverAppId(call) {
                self.receiverAppId = appId
                GCKCastContext.sharedInstance().sessionManager.setDefaultSessionOptions(
                    ["gck_applicationID": NSString(string: appId)],
                    forDeviceCategory: kGCKCastDeviceCategory
                )
            }

            self.discoveryManager = GCKCastContext.sharedInstance().discoveryManager
            self.sessionManager = GCKCastContext.sharedInstance().sessionManager

            // Add listeners
            self.discoveryManager?.add(self)
            self.sessionManager?.add(self)

            // Start discovery
            self.discoveryManager?.startDiscovery()

            let deviceCount = self.discoveryManager?.deviceCount ?? 0
            print("[CastPlayerPlugin] Discovery started, initial device count: \(deviceCount)")

            // Check for existing session
            if let session = self.sessionManager?.currentCastSession {
                self.currentSession = session
                self.remoteMediaClient = session.remoteMediaClient
                self.remoteMediaClient?.add(self)
                print("[CastPlayerPlugin] Found existing session: \(session.device.friendlyName ?? "Unknown")")
            }

            self.isInitialized = true
            print("[CastPlayerPlugin] Initialized successfully")
            call.resolve()
        }
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let available = self.discoveryManager?.deviceCount ?? 0 > 0
            call.resolve(["available": available])
        }
    }

    @objc func restartDiscovery(_ call: CAPPluginCall) {
        print("[CastPlayerPlugin] restartDiscovery called")

        DispatchQueue.main.async {
            // Restart discovery
            self.discoveryManager?.stopDiscovery()
            self.discoveryManager?.startDiscovery()

            // Check for existing session
            if let session = self.sessionManager?.currentCastSession {
                self.currentSession = session
                self.remoteMediaClient = session.remoteMediaClient
                self.remoteMediaClient?.add(self)
                print("[CastPlayerPlugin] Found existing session after restart")
            }

            let deviceCount = self.discoveryManager?.deviceCount ?? 0
            print("[CastPlayerPlugin] Discovery restarted, device count: \(deviceCount)")

            call.resolve([
                "success": true,
                "castState": deviceCount > 0 ? 2 : 1
            ])
        }
    }

    @objc func requestSession(_ call: CAPPluginCall) {
        guard isInitialized else {
            call.reject("Chromecast not initialized")
            return
        }

        DispatchQueue.main.async {
            guard let discoveryManager = self.discoveryManager else {
                call.reject("Discovery manager not available")
                return
            }

            let deviceCount = discoveryManager.deviceCount
            print("[CastPlayerPlugin] Found \(deviceCount) devices")

            if deviceCount == 0 {
                call.reject("Aucun appareil Cast trouvé")
                return
            }

            // Build device list
            var devices: [GCKDevice] = []
            var deviceNames: [String] = []

            for i in 0..<deviceCount {
                let device = discoveryManager.device(at: i)
                devices.append(device)
                deviceNames.append(device.friendlyName ?? "Unknown Device")
            }

            // Create custom alert controller with white background
            let alert = UIAlertController(
                title: "Sélectionner un appareil",
                message: nil,
                preferredStyle: .actionSheet
            )

            // Style the alert for light theme
            if let view = alert.view.subviews.first?.subviews.first?.subviews.first {
                view.backgroundColor = UIColor.white
            }

            // Add device options
            for (index, deviceName) in deviceNames.enumerated() {
                let action = UIAlertAction(title: deviceName, style: .default) { _ in
                    print("[CastPlayerPlugin] User selected: \(deviceName)")
                    self.sessionManager?.startSession(with: devices[index])
                }
                alert.addAction(action)
            }

            // Add cancel button
            let cancelAction = UIAlertAction(title: "Annuler", style: .cancel)
            alert.addAction(cancelAction)

            // Configure for iPad
            if let popover = alert.popoverPresentationController {
                popover.sourceView = self.bridge?.viewController?.view
                popover.sourceRect = CGRect(
                    x: self.bridge?.viewController?.view.bounds.midX ?? 0,
                    y: self.bridge?.viewController?.view.bounds.midY ?? 0,
                    width: 0,
                    height: 0
                )
                popover.permittedArrowDirections = []
            }

            // Present the alert
            self.bridge?.viewController?.present(alert, animated: true)

            call.resolve([
                "sessionId": "pending",
                "deviceName": ""
            ])
        }
    }

    @objc func endSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.sessionManager?.endSessionAndStopCasting(true)
            call.resolve()
        }
    }

    @objc func loadMedia(_ call: CAPPluginCall) {
        print("[CastPlayerPlugin] loadMedia called")

        // Check if we have a session
        guard let session = currentSession else {
            print("[CastPlayerPlugin] ERROR: No current session")
            call.reject("No active cast session")
            return
        }

        print("[CastPlayerPlugin] Session exists, connection state: \(session.connectionState.rawValue)")

        // Get or refresh remoteMediaClient from session
        let client = session.remoteMediaClient
        guard let remoteClient = client else {
            print("[CastPlayerPlugin] ERROR: No remoteMediaClient on session")
            call.reject("Remote media client not available")
            return
        }

        guard let url = call.getString("url") else {
            print("[CastPlayerPlugin] ERROR: No URL provided")
            call.reject("URL is required")
            return
        }

        let contentType = call.getString("contentType") ?? "application/x-mpegURL"
        let title = call.getString("title") ?? ""
        let description = call.getString("description") ?? ""
        let posterUrl = call.getString("posterUrl")
        let startPosition = call.getDouble("startPosition") ?? 0.0
        let autoplay = call.getBool("autoplay") ?? true

        // Clean URL
        let cleanUrl = url.replacingOccurrences(of: "\\/", with: "/")
        print("[CastPlayerPlugin] ====== LOADING MEDIA ======")
        print("[CastPlayerPlugin] URL: \(cleanUrl)")
        print("[CastPlayerPlugin] Content-Type: \(contentType)")
        print("[CastPlayerPlugin] Title: \(title)")
        print("[CastPlayerPlugin] Autoplay: \(autoplay)")

        DispatchQueue.main.async {
            // Build metadata
            let metadata = GCKMediaMetadata(metadataType: .movie)
            metadata.setString(title, forKey: kGCKMetadataKeyTitle)
            metadata.setString(description, forKey: kGCKMetadataKeySubtitle)

            if let posterUrl = posterUrl, let imageUrl = URL(string: posterUrl) {
                metadata.addImage(GCKImage(url: imageUrl, width: 480, height: 720))
                print("[CastPlayerPlugin] Added poster image: \(posterUrl)")
            }

            // Build media info
            guard let contentURL = URL(string: cleanUrl) else {
                print("[CastPlayerPlugin] ERROR: Invalid URL")
                call.reject("Invalid URL")
                return
            }

            let mediaInfoBuilder = GCKMediaInformationBuilder(contentURL: contentURL)
            // IMPORTANT: Set contentID explicitly - the receiver uses this, not contentURL
            mediaInfoBuilder.contentID = cleanUrl
            mediaInfoBuilder.contentType = contentType
            mediaInfoBuilder.streamType = .buffered
            mediaInfoBuilder.metadata = metadata

            let mediaInfo = mediaInfoBuilder.build()
            print("[CastPlayerPlugin] MediaInfo built: contentId=\(mediaInfo.contentID ?? "nil")")
            print("[CastPlayerPlugin] MediaInfo contentURL=\(mediaInfo.contentURL?.absoluteString ?? "nil")")

            // Build load options
            let loadOptions = GCKMediaLoadOptions()
            loadOptions.autoplay = autoplay
            loadOptions.playPosition = startPosition

            // Pass customData to receiver (e.g. auth token, tracking payload)
            if let customData = call.getObject("customData") as? [String: Any], !customData.isEmpty {
                loadOptions.customData = NSDictionary(dictionary: customData)
                print("[CastPlayerPlugin] customData set for receiver (\(customData.count) keys)")
            }

            // Load media
            print("[CastPlayerPlugin] Calling remoteClient.loadMedia...")
            let request = remoteClient.loadMedia(mediaInfo, with: loadOptions)
            request.delegate = self

            print("[CastPlayerPlugin] loadMedia request sent")
            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        guard let remoteMediaClient = remoteMediaClient else {
            call.reject("No active cast session")
            return
        }
        DispatchQueue.main.async {
            remoteMediaClient.play()
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        guard let remoteMediaClient = remoteMediaClient else {
            call.reject("No active cast session")
            return
        }
        DispatchQueue.main.async {
            remoteMediaClient.pause()
            call.resolve()
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        guard let remoteMediaClient = remoteMediaClient else {
            call.reject("No active cast session")
            return
        }
        let position = call.getDouble("position") ?? 0.0
        DispatchQueue.main.async {
            let seekOptions = GCKMediaSeekOptions()
            seekOptions.interval = position
            remoteMediaClient.seek(with: seekOptions)
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        guard let remoteMediaClient = remoteMediaClient else {
            call.reject("No active cast session")
            return
        }
        DispatchQueue.main.async {
            remoteMediaClient.stop()
            call.resolve()
        }
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        guard let remoteMediaClient = remoteMediaClient else {
            call.reject("No active cast session")
            return
        }
        let volume = call.getFloat("volume") ?? 1.0
        DispatchQueue.main.async {
            remoteMediaClient.setStreamVolume(volume)
            call.resolve()
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var result: [String: Any] = [:]

            let deviceCount = self.discoveryManager?.deviceCount ?? 0
            result["available"] = deviceCount > 0
            result["connected"] = self.currentSession?.connectionState == .connected
            result["initialized"] = self.isInitialized

            if let device = self.currentSession?.device {
                result["deviceName"] = device.friendlyName
            }
            if let sessionId = self.currentSession?.sessionID {
                result["sessionId"] = sessionId
            }

            call.resolve(result)
        }
    }

    @objc func getDiagnostics(_ call: CAPPluginCall) {
        print("[CastPlayerPlugin] === getDiagnostics called ===")
        DispatchQueue.main.async {
            var diagnostics: [String: Any] = [:]

            // Basic state
            diagnostics["initialized"] = self.isInitialized
            diagnostics["hasDiscoveryManager"] = self.discoveryManager != nil
            diagnostics["hasSessionManager"] = self.sessionManager != nil
            diagnostics["hasCurrentSession"] = self.currentSession != nil
            diagnostics["hasRemoteMediaClient"] = self.remoteMediaClient != nil

            // Discovery manager info
            if let discoveryManager = self.discoveryManager {
                let deviceCount = discoveryManager.deviceCount
                var castContextInfo: [String: Any] = [:]
                castContextInfo["deviceCount"] = deviceCount
                castContextInfo["available"] = deviceCount > 0
                castContextInfo["castStateName"] = deviceCount > 0 ? "DEVICES_AVAILABLE" : "NO_DEVICES"
                diagnostics["castContext"] = castContextInfo

                // List all devices
                var devices: [[String: Any]] = []
                for i in 0..<deviceCount {
                    let device = discoveryManager.device(at: i)
                    var deviceInfo: [String: Any] = [:]
                    deviceInfo["friendlyName"] = device.friendlyName ?? "Unknown"
                    deviceInfo["modelName"] = device.modelName ?? ""
                    deviceInfo["deviceVersion"] = device.deviceVersion ?? ""
                    deviceInfo["ipAddress"] = device.ipAddress.description ?? ""
                    deviceInfo["servicePort"] = device.servicePort
                    devices.append(deviceInfo)
                    print("[CastPlayerPlugin] Device \(i): \(device.friendlyName ?? "Unknown")")
                }
                diagnostics["discoveredDevices"] = devices
            } else {
                diagnostics["castContext"] = ["available": false, "castStateName": "NOT_INITIALIZED"]
                diagnostics["discoveredDevices"] = []
            }

            // Current session info
            if let session = self.currentSession {
                var sessionInfo: [String: Any] = [:]
                sessionInfo["sessionId"] = session.sessionID ?? ""
                sessionInfo["isConnected"] = session.connectionState == .connected
                sessionInfo["isConnecting"] = session.connectionState == .connecting

                let device = session.device
                var deviceInfo: [String: Any] = [:]
                deviceInfo["friendlyName"] = device.friendlyName ?? ""
                deviceInfo["modelName"] = device.modelName ?? ""
                deviceInfo["deviceVersion"] = device.deviceVersion ?? ""
                deviceInfo["ipAddress"] = device.ipAddress.description ?? ""
                deviceInfo["servicePort"] = device.servicePort
                sessionInfo["device"] = deviceInfo
                diagnostics["currentSession"] = sessionInfo
            } else {
                diagnostics["currentSession"] = nil
            }

            // Receiver App ID info
            var receiverInfo: [String: Any] = [:]
            receiverInfo["receiverAppId"] = self.receiverAppId
            diagnostics["receiver"] = receiverInfo

            print("[CastPlayerPlugin] === Diagnostics completed ===")
            call.resolve(diagnostics)
        }
    }

    // MARK: - GCKDiscoveryManagerListener

    public func didUpdateDeviceList() {
        let available = (discoveryManager?.deviceCount ?? 0) > 0
        notifyListeners("availabilityChanged", data: ["available": available])
    }

    // MARK: - GCKSessionManagerListener

    public func sessionManager(_ sessionManager: GCKSessionManager, didStart session: GCKCastSession) {
        currentSession = session
        remoteMediaClient = session.remoteMediaClient
        remoteMediaClient?.add(self)

        notifyListeners("sessionStateChanged", data: [
            "state": "connected",
            "deviceName": session.device.friendlyName ?? ""
        ])
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, didEnd session: GCKCastSession, withError error: Error?) {
        currentSession = nil
        remoteMediaClient = nil

        notifyListeners("sessionStateChanged", data: [
            "state": "disconnected"
        ])
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, didFailToStart session: GCKCastSession, withError error: Error) {
        notifyListeners("sessionStateChanged", data: [
            "state": "failed"
        ])
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, didSuspend session: GCKCastSession, with reason: GCKConnectionSuspendReason) {
        notifyListeners("sessionStateChanged", data: [
            "state": "suspended"
        ])
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, willResumeCastSession session: GCKCastSession) {
        notifyListeners("sessionStateChanged", data: [
            "state": "resuming"
        ])
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, didResumeCastSession session: GCKCastSession) {
        currentSession = session
        remoteMediaClient = session.remoteMediaClient
        remoteMediaClient?.add(self)

        notifyListeners("sessionStateChanged", data: [
            "state": "connected",
            "deviceName": session.device.friendlyName ?? ""
        ])
    }

    // MARK: - GCKRemoteMediaClientListener

    public func remoteMediaClient(_ client: GCKRemoteMediaClient, didUpdate mediaStatus: GCKMediaStatus?) {
        guard let mediaStatus = mediaStatus else { return }

        var playerState = "unknown"
        switch mediaStatus.playerState {
        case .idle:
            playerState = "idle"
        case .playing:
            playerState = "playing"
        case .paused:
            playerState = "paused"
        case .buffering:
            playerState = "buffering"
        case .loading:
            playerState = "loading"
        @unknown default:
            playerState = "unknown"
        }

        var idleReason = "none"
        if mediaStatus.playerState == .idle {
            switch mediaStatus.idleReason {
            case .finished:
                idleReason = "finished"
            case .cancelled:
                idleReason = "canceled"
            case .interrupted:
                idleReason = "interrupted"
            case .error:
                idleReason = "error"
            case .none:
                idleReason = "none"
            @unknown default:
                idleReason = "none"
            }
        }

        notifyListeners("mediaStateChanged", data: [
            "playerState": playerState,
            "idleReason": idleReason,
            "currentTime": mediaStatus.streamPosition,
            "duration": mediaStatus.mediaInformation?.streamDuration ?? 0,
            "volume": client.mediaStatus?.volume ?? 1.0,
            "muted": client.mediaStatus?.isMuted ?? false
        ])
    }
}

// MARK: - GCKRequestDelegate
extension CastPlayerPlugin: GCKRequestDelegate {
    public func requestDidComplete(_ request: GCKRequest) {
        print("[CastPlayerPlugin] ✅ Request completed successfully - requestID: \(request.requestID)")
        notifyListeners("mediaStateChanged", data: [
            "playerState": "loading",
            "message": "Media request completed"
        ])
    }

    public func request(_ request: GCKRequest, didFailWithError error: GCKError) {
        print("[CastPlayerPlugin] ❌ Request failed - requestID: \(request.requestID)")
        print("[CastPlayerPlugin] Error code: \(error.code)")
        print("[CastPlayerPlugin] Error description: \(error.localizedDescription)")
        print("[CastPlayerPlugin] Error userInfo: \(error.userInfo)")
        notifyListeners("mediaStateChanged", data: [
            "playerState": "error",
            "error": error.localizedDescription
        ])
    }

    public func request(_ request: GCKRequest, didAbortWith abortReason: GCKRequestAbortReason) {
        print("[CastPlayerPlugin] ⚠️ Request aborted - reason: \(abortReason.rawValue)")
    }
}
