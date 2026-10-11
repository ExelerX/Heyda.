package expo.modules.heydabackground

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.facebook.react.HeadlessJsTaskService

/**
 * Restarts the keep-alive service after a reboot (and after an app update, which also stops it),
 * but only when the user enabled that (setStartOnBoot). Both broadcasts are exempt from the
 * Android 12+ background-start restriction, and remoteMessaging is not among the types that
 * Android 15 forbids starting from BOOT_COMPLETED.
 */
class KeepAliveBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action
    if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    if (!KeepAlivePrefs.isStartOnBoot(context)) return
    try {
      KeepAliveService.start(context, KeepAlivePrefs.loadText(context))
      // Keeps the CPU awake until the service has started the JS task (released in its onDestroy).
      HeadlessJsTaskService.acquireWakeLockNow(context)
    } catch (e: Exception) {
      Log.w(TAG, "Could not restart the keep-alive service after $action", e)
    }
  }

  private companion object {
    const val TAG = "HeydaKeepAlive"
  }
}
