package expo.modules.heydabackground

import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** JS API of the keep-alive service. Wrapped by apps/mobile/src/lib/keepalive.ts. */
class HeydaBackgroundModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("HeydaBackground")

    // Starts the foreground service (or updates its text). Rejects with ERR_KEEPALIVE_NOT_ALLOWED
    // when Android refuses a background start, ERR_KEEPALIVE_START_FAILED otherwise.
    AsyncFunction("start") { title: String?, body: String? ->
      val ctx = context
      val text = KeepAliveText.of(title, body)
      KeepAlivePrefs.saveText(ctx, text)
      KeepAliveService.start(ctx, text)
    }

    AsyncFunction<Unit>("stop") {
      KeepAliveService.stop(context)
    }

    AsyncFunction<Boolean>("isRunning") {
      KeepAliveService.running
    }

    AsyncFunction("setStartOnBoot") { enabled: Boolean ->
      KeepAlivePrefs.setStartOnBoot(context, enabled)
    }

    AsyncFunction<Boolean>("isIgnoringBatteryOptimizations") {
      val ctx = context
      val power = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
      power?.isIgnoringBatteryOptimizations(ctx.packageName) ?: false
    }

    // True when the user allowed this app to override Do Not Disturb ("Bitte nicht stören"-Zugriff).
    // Only then does Android keep bypassDnd on a newly created notification channel.
    AsyncFunction<Boolean>("isNotificationPolicyAccessGranted") {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      manager?.isNotificationPolicyAccessGranted ?: false
    }

    // Opens the system list where the user can exempt the app from battery optimization.
    // Deliberately not ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS (needs a restricted permission).
    AsyncFunction<Unit>("openBatteryOptimizationSettings") {
      openBatteryOptimizationSettings()
    }.runOnQueue(Queues.MAIN)
  }

  private fun openBatteryOptimizationSettings() {
    val ctx = context
    val candidates = listOf(
      Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
      // Fallback for devices without that screen: the app's info page (Battery -> Unrestricted).
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))
    )
    val activity = appContext.currentActivity
    for (intent in candidates) {
      try {
        if (activity != null) {
          activity.startActivity(intent)
        } else {
          ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        return
      } catch (_: ActivityNotFoundException) {
        // try the next screen
      }
    }
    throw BatterySettingsUnavailableException()
  }
}
