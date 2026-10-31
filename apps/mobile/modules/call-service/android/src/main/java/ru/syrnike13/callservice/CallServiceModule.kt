package ru.syrnike13.callservice

import android.app.PictureInPictureParams
import android.content.Intent
import android.os.Build
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.core.app.PictureInPictureModeChangedInfo
import androidx.core.content.ContextCompat
import androidx.core.util.Consumer
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Android rejects PiP aspect ratios outside 1:2.39..2.39:1.
private const val MAX_PIP_ASPECT = 2.39

class CallServiceModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private var pipActivity: ComponentActivity? = null
  private val pipListener = Consumer<PictureInPictureModeChangedInfo> { info ->
    sendEvent(PIP_EVENT, mapOf("active" to info.isInPictureInPictureMode))
  }

  /** The activity can be recreated, so the listener follows the current one. */
  private fun observePictureInPicture() {
    val activity = appContext.currentActivity as? ComponentActivity ?: return
    if (activity === pipActivity) return
    pipActivity?.removeOnPictureInPictureModeChangedListener(pipListener)
    activity.addOnPictureInPictureModeChangedListener(pipListener)
    pipActivity = activity
  }

  override fun definition() = ModuleDefinition {
    Name("CallService")
    Events(PIP_EVENT)

    OnCreate { observePictureInPicture() }
    OnActivityEntersForeground { observePictureInPicture() }
    OnDestroy { pipActivity?.removeOnPictureInPictureModeChangedListener(pipListener) }

    // Must be called while the app is visible: Android 14+ refuses to start a
    // microphone foreground service from the background.
    Function("start") { title: String, text: String ->
      val intent = Intent(context, CallService::class.java)
        .putExtra(CallService.EXTRA_TITLE, title)
        .putExtra(CallService.EXTRA_TEXT, text)
      ContextCompat.startForegroundService(context, intent)
    }

    Function("stop") {
      context.stopService(Intent(context, CallService::class.java))
    }

    // While enabled, leaving the app (home gesture, app switch) moves it into a
    // PiP window with the given aspect ratio. Auto-enter needs Android 12+.
    Function("setPictureInPicture") { enabled: Boolean, width: Int, height: Int ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function
      val activity = appContext.currentActivity ?: return@Function
      val aspect = (width.toDouble() / height.coerceAtLeast(1))
        .coerceIn(1 / MAX_PIP_ASPECT, MAX_PIP_ASPECT)
      val params = PictureInPictureParams.Builder()
        .setAutoEnterEnabled(enabled)
        .setAspectRatio(Rational((aspect * 1000).toInt(), 1000))
        .build()
      activity.runOnUiThread { activity.setPictureInPictureParams(params) }
    }

    Function("isInPictureInPicture") {
      appContext.currentActivity?.isInPictureInPictureMode ?: false
    }
  }

  companion object {
    private const val PIP_EVENT = "onPictureInPictureModeChanged"
  }
}
