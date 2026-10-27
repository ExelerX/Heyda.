package expo.modules.heydabackground

import expo.modules.kotlin.exception.CodedException

/** Android 12+ refused to start the foreground service because the app is in the background. */
internal class KeepAliveNotAllowedException(cause: Throwable) :
  CodedException(
    "ERR_KEEPALIVE_NOT_ALLOWED",
    "Android does not allow starting the keep-alive service while the app is in the background. " +
      "Start it while the app is visible.",
    cause
  )

internal class KeepAliveStartFailedException(cause: Throwable) :
  CodedException(
    "ERR_KEEPALIVE_START_FAILED",
    "Could not start the keep-alive service: ${cause.message}",
    cause
  )

internal class BatterySettingsUnavailableException :
  CodedException(
    "ERR_KEEPALIVE_SETTINGS_UNAVAILABLE",
    "This device has no battery optimization settings screen.",
    null
  )
