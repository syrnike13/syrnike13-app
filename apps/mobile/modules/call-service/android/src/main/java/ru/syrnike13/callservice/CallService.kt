package ru.syrnike13.callservice

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Keeps the process alive while the user is in a voice channel. Android stops
 * microphone capture of background apps unless a `microphone` foreground
 * service with a visible notification is running.
 */
class CallService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE).orEmpty()
    val text = intent?.getStringExtra(EXTRA_TEXT).orEmpty()

    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, title, NotificationManager.IMPORTANCE_LOW),
    )

    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = PendingIntent.getActivity(
      this,
      0,
      launch,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    val notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(applicationInfo.icon)
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .build()

    ServiceCompat.startForeground(
      this,
      NOTIFICATION_ID,
      notification,
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
    )
    return START_NOT_STICKY
  }

  companion object {
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    private const val CHANNEL_ID = "voice-call"
    private const val NOTIFICATION_ID = 1
  }
}
