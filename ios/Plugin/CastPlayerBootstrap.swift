import Foundation
import GoogleCast

/// À appeler depuis `AppDelegate.application(_:didFinishLaunchingWithOptions:)` **avant** le bootstrap Angular.
@objc public class CastPlayerBootstrap: NSObject {
    @objc public static func configure() {
        configure(receiverAppId: readReceiverAppId() ?? kGCKDefaultMediaReceiverApplicationID)
    }

    @objc public static func configure(receiverAppId: String) {
        let discoveryCriteria = GCKDiscoveryCriteria(applicationID: kGCKDefaultMediaReceiverApplicationID)
        let options = GCKCastOptions(discoveryCriteria: discoveryCriteria)
        GCKCastContext.setSharedInstanceWith(options)
        GCKCastContext.sharedInstance().sessionManager.setDefaultSessionOptions(
            ["gck_applicationID": NSString(string: receiverAppId)],
            forDeviceCategory: kGCKCastDeviceCategory
        )
        GCKCastContext.sharedInstance().useDefaultExpandedMediaControls = true
    }

    @objc public static func readReceiverAppId() -> String? {
        guard let url = Bundle.main.url(forResource: "capacitor.config", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let plugins = json["plugins"] as? [String: Any],
              let castPlayer = plugins["CastPlayer"] as? [String: Any],
              let id = castPlayer["receiverAppId"] as? String
        else {
            return nil
        }
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
