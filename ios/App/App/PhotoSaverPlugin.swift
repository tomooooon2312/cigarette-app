import Capacitor
import Photos
import UIKit

/// STEP 9：撮影した AR 写真を写真アプリに追加する、アプリ内の最小限のプラグイン（JavaScript 側は src/lib/photoSaver.ts）。
/// 権限は「写真の追加のみ」（PHAccessLevel.addOnly、Info.plist の NSPhotoLibraryAddUsageDescription）。写真の読み取りはしない。
@objc(PhotoSaverPlugin)
public class PhotoSaverPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PhotoSaverPlugin"
    public let jsName = "PhotoSaver"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveImage", returnType: CAPPluginReturnPromise)
    ]

    /// data：JPEG / PNG の base64（data: の前置きなし）
    @objc func saveImage(_ call: CAPPluginCall) {
        guard let base64 = call.getString("data"), let data = Data(base64Encoded: base64), UIImage(data: data) != nil else {
            call.reject("画像のデータが正しくありません", "INVALID_DATA")
            return
        }
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                call.reject("写真への追加が許可されていません", "PERMISSION_DENIED")
                return
            }
            PHPhotoLibrary.shared().performChanges({
                let request = PHAssetCreationRequest.forAsset()
                request.addResource(with: .photo, data: data, options: nil)
            }, completionHandler: { success, error in
                if success {
                    call.resolve()
                } else {
                    call.reject(error?.localizedDescription ?? "写真を保存できませんでした", "SAVE_FAILED")
                }
            })
        }
    }
}

/// アプリのプラグイン（PhotoSaverPlugin）を登録するための Capacitor のブリッジ（SceneDelegate から使う）
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PhotoSaverPlugin())
    }
}
