package expo.modules.heydabackground

import android.app.ForegroundServiceStartNotAllowedException
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Foreground service (type remoteMessaging) that runs the React Native headless JS task
 * [TASK_KEY] without a timeout. While it runs, the process and its JS runtime stay alive (and the
 * base class holds a partial wake lock), so JS timers and the relay WebSocket keep working when
 * the app is in the background or its activity was destroyed.
 *
 * The JS task never resolves on its own; it resolves when JS calls stopKeepAlive(). The base class
 * then stops this service ([HeadlessJsTaskService.onHeadlessJsTaskFinish] calls stopSelf()).
 * Starting again while running only replaces the notification text; it does not start a second
 * JS task.
 */
class KeepAliveService : HeadlessJsTaskService() {
  private var taskStarted = false

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      // Commands arrive in order, so a start sent just before this one has already called
      // startForeground(). stopSelf(startId) does nothing if a newer start is still queued.
      stopSelf(startId)
      return Service.START_NOT_STICKY
    }
    val text = textFrom(intent) ?: KeepAlivePrefs.loadText(this)
    // Must happen first: after startForegroundService() Android expects startForeground() within seconds.
    if (!enterForeground(text)) {
      running = false
      stopSelf()
      return Service.START_NOT_STICKY
    }
    running = true
    if (taskStarted) {
      return Service.START_REDELIVER_INTENT
    }
    return try {
      // Calls getTaskConfig() and starts the JS task (creating the React instance if needed).
      val result = super.onStartCommand(intent, flags, startId)
      taskStarted = true
      result
    } catch (e: RuntimeException) {
      Log.e(TAG, "Could not start the headless JS task", e)
      running = false
      stopSelf()
      Service.START_NOT_STICKY
    }
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(
      TASK_KEY,
      Arguments.createMap(),
      0L, // no timeout: the task runs until JS calls stopKeepAlive()
      true // allowed while the app is in the foreground (it is usually started from the UI)
    )

  override fun onDestroy() {
    running = false
    taskStarted = false
    super.onDestroy()
  }

  private fun enterForeground(text: KeepAliveText): Boolean {
    return try {
      val notification = KeepAliveNotification.build(this, text)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        ServiceCompat.startForeground(
          this,
          KeepAliveNotification.NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
        )
      } else {
        startForeground(KeepAliveNotification.NOTIFICATION_ID, notification)
      }
      true
    } catch (e: Exception) {
      // ForegroundServiceStartNotAllowedException (Android 12+: e.g. a system restart while the
      // app is in the background) or SecurityException (missing FGS type permission, Android 14+).
      Log.w(TAG, "Could not move the keep-alive service to the foreground", e)
      false
    }
  }

  companion object {
    const val TASK_KEY = "HeydaKeepAlive"
    private const val TAG = "HeydaKeepAlive"
    private const val EXTRA_TITLE = "expo.modules.heydabackground.TITLE"
    private const val EXTRA_BODY = "expo.modules.heydabackground.BODY"
    private const val ACTION_STOP = "expo.modules.heydabackground.STOP"

    /** True from a successful startForeground() until onDestroy(). Same process as the module. */
    @Volatile
    internal var running = false

    private fun textFrom(intent: Intent?): KeepAliveText? {
      if (intent == null) return null
      val title = intent.getStringExtra(EXTRA_TITLE) ?: return null
      return KeepAliveText.of(title, intent.getStringExtra(EXTRA_BODY))
    }

    /**
     * Starts the service, or updates its notification text when it already runs.
     * @throws KeepAliveNotAllowedException when Android refuses a start from the background (Android 12+)
     * @throws KeepAliveStartFailedException for any other refusal
     */
    internal fun start(context: Context, text: KeepAliveText) {
      val intent = Intent(context, KeepAliveService::class.java)
        .putExtra(EXTRA_TITLE, text.title)
        .putExtra(EXTRA_BODY, text.body)
      try {
        ContextCompat.startForegroundService(context, intent)
      } catch (e: IllegalStateException) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && e is ForegroundServiceStartNotAllowedException) {
          throw KeepAliveNotAllowedException(e)
        }
        throw KeepAliveStartFailedException(e)
      } catch (e: SecurityException) {
        throw KeepAliveStartFailedException(e)
      }
    }

    /**
     * Stops the service. Safe to call when it is not running.
     *
     * Goes through the service's own command queue instead of stopService(): stopping a service
     * started with startForegroundService() before it reached startForeground() (a quick on/off
     * toggle) makes Android crash the app. If Android refuses the command (app in the background
     * and the service not running), stopService() is the fallback; there is nothing to race then.
     */
    internal fun stop(context: Context) {
      val intent = Intent(context, KeepAliveService::class.java).setAction(ACTION_STOP)
      try {
        context.startService(intent)
      } catch (e: IllegalStateException) {
        context.stopService(Intent(context, KeepAliveService::class.java))
      } catch (e: SecurityException) {
        context.stopService(Intent(context, KeepAliveService::class.java))
      }
    }
  }
}
