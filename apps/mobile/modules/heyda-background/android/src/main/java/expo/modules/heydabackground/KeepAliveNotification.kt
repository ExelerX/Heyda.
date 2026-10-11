package expo.modules.heydabackground

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/** The persistent, low-importance notification that a foreground service must show. */
internal object KeepAliveNotification {
  const val NOTIFICATION_ID = 0x4E59 // any non-zero id; unique within this app's notifications
  private const val CHANNEL_ID = "heyda-keepalive"
  private const val CHANNEL_NAME = "Verbindung im Hintergrund"
  private const val CHANNEL_DESCRIPTION =
    "Hält die Verbindung offen, damit Nachrichten und Notrufe sofort ankommen."

  fun build(context: Context, text: KeepAliveText): Notification {
    ensureChannel(context)
    return NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(smallIcon(context))
      .setContentTitle(text.title)
      .setContentText(text.body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text.body))
      .setContentIntent(openAppIntent(context))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .build()
  }

  /** Low importance: no sound, no heads-up, still listed. No-op below Android 8. */
  private fun ensureChannel(context: Context) {
    val channel = NotificationChannelCompat.Builder(CHANNEL_ID, NotificationManagerCompat.IMPORTANCE_LOW)
      .setName(CHANNEL_NAME)
      .setDescription(CHANNEL_DESCRIPTION)
      .setShowBadge(false)
      .build()
    NotificationManagerCompat.from(context).createNotificationChannel(channel)
  }

  /**
   * Uses the app-wide notification icon when expo-notifications was given one (drawable
   * "notification_icon"), so all Heyda. notifications look alike; otherwise the module's chevron.
   */
  private fun smallIcon(context: Context): Int {
    val appIcon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    return if (appIcon != 0) appIcon else R.drawable.heyda_keepalive_notification_icon
  }

  /** Tapping the notification brings the app to the front (like the launcher icon). */
  private fun openAppIntent(context: Context): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    return PendingIntent.getActivity(
      context,
      0,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }
}
