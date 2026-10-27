package expo.modules.heydabackground

import android.content.Context
import android.content.SharedPreferences

/** Text of the ongoing notification. German defaults, used when JS passes nothing. */
internal data class KeepAliveText(val title: String, val body: String) {
  companion object {
    const val DEFAULT_TITLE = "Heyda. ist verbunden"
    const val DEFAULT_BODY = "Damit Nachrichten und Notrufe sofort ankommen."
    private const val MAX_LENGTH = 200

    fun of(title: String?, body: String?): KeepAliveText =
      KeepAliveText(clean(title, DEFAULT_TITLE), clean(body, DEFAULT_BODY))

    private fun clean(value: String?, fallback: String): String {
      val trimmed = value?.trim().orEmpty()
      return if (trimmed.isEmpty()) fallback else trimmed.take(MAX_LENGTH)
    }
  }
}

/**
 * Small settings store. The app sets allowBackup=false, so nothing here leaves the device.
 * Holds the start-on-boot flag and the last notification text (reused after a reboot).
 */
internal object KeepAlivePrefs {
  private const val FILE = "heyda_keepalive"
  private const val KEY_START_ON_BOOT = "startOnBoot"
  private const val KEY_TITLE = "title"
  private const val KEY_BODY = "body"

  private fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  fun isStartOnBoot(context: Context): Boolean =
    prefs(context).getBoolean(KEY_START_ON_BOOT, false)

  fun setStartOnBoot(context: Context, enabled: Boolean) {
    prefs(context).edit().putBoolean(KEY_START_ON_BOOT, enabled).apply()
  }

  fun loadText(context: Context): KeepAliveText {
    val p = prefs(context)
    return KeepAliveText.of(p.getString(KEY_TITLE, null), p.getString(KEY_BODY, null))
  }

  fun saveText(context: Context, text: KeepAliveText) {
    prefs(context).edit().putString(KEY_TITLE, text.title).putString(KEY_BODY, text.body).apply()
  }
}
