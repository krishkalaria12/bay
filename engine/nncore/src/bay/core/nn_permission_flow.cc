// Copyright 2026 Bay. Apache-2.0.
#include "bay/core/nn_permission_flow.h"

#include "components/permissions/embedded_permission_prompt_flow_model.h"

namespace nncore {

PermissionStep PermissionStepOf(
    permissions::PermissionPrompt::Delegate* delegate) {
  using Variant = permissions::EmbeddedPermissionPromptFlowModel::Variant;
  permissions::EmbeddedPermissionPromptFlowModel* flow =
      delegate->GetEmbeddedPromptFlowModel();
  if (!flow)
    return PermissionStep::kAsk;
  // The manager marks its requests displayed once their first view is up; a
  // view made for the same requests after that is a later step (a prompt keeps
  // itself through tab switches and anchor updates, so nothing else recreates
  // it).
  const bool later_step = delegate->WasCurrentRequestAlreadyDisplayed();
  switch (flow->prompt_variant()) {
    case Variant::kOsPrompt:
      return PermissionStep::kSystemPrompt;
    case Variant::kAsk:
    case Variant::kPreviouslyDenied:
      return later_step ? PermissionStep::kAcknowledge : PermissionStep::kAsk;
    case Variant::kPreviouslyGranted:
      return later_step ? PermissionStep::kAcknowledge
                        : PermissionStep::kAlreadyAllowed;
    case Variant::kOsSystemSettings:
    case Variant::kAdministratorGranted:
    case Variant::kAdministratorDenied:
    case Variant::kUninitialized:
      return PermissionStep::kAcknowledge;
  }
  return PermissionStep::kAcknowledge;
}

const char* PermissionKindName(permissions::RequestType type) {
  using permissions::RequestType;
  switch (type) {
    case RequestType::kCameraStream:
      return "camera";
    case RequestType::kMicStream:
      return "microphone";
    case RequestType::kCameraPanTiltZoom:
      return "cameraPanTiltZoom";
    case RequestType::kGeolocation:
      return "location";
    case RequestType::kNotifications:
      return "notifications";
    case RequestType::kClipboard:
      return "clipboard";
    case RequestType::kMidiSysex:
      return "midi";
    case RequestType::kMultipleDownloads:
      return "multipleDownloads";
    case RequestType::kLocalFonts:
      return "localFonts";
    case RequestType::kIdleDetection:
      return "idleDetection";
    case RequestType::kStorageAccess:
    case RequestType::kTopLevelStorageAccess:
      return "storageAccess";
    case RequestType::kWindowManagement:
      return "windowManagement";
    case RequestType::kFileSystemAccess:
      return "fileSystem";
    case RequestType::kKeyboardLock:
      return "keyboardLock";
    case RequestType::kPointerLock:
      return "pointerLock";
    case RequestType::kRegisterProtocolHandler:
      return "protocolHandler";
    case RequestType::kSensors:
      return "sensors";
    case RequestType::kLocalNetwork:
    case RequestType::kLoopbackNetwork:
      return "localNetwork";
    case RequestType::kVrSession:
      return "vr";
    case RequestType::kArSession:
      return "ar";
    case RequestType::kHandTracking:
      return "handTracking";
    case RequestType::kIdentityProvider:
      return "identityProvider";
    case RequestType::kWebAppInstallation:
      return "webAppInstallation";
    case RequestType::kCapturedSurfaceControl:
      return "capturedSurfaceControl";
    case RequestType::kDiskQuota:
      return "diskQuota";
    default:
      return nullptr;
  }
}

}  // namespace nncore
