package ru.syrnike13.appupdate

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

class AppUpdateModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("AppUpdate")

    // Android asks the user once per app to allow installs from it.
    Function("canInstall") {
      context.packageManager.canRequestPackageInstalls()
    }

    Function("openInstallSettings") {
      val intent = Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:${context.packageName}"),
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    // Downloads the APK, refuses it unless its SHA-256 matches the release
    // feed, then opens the system installer. Runs off the main thread.
    AsyncFunction("downloadAndInstall") { url: String, sha256: String ->
      val dir = File(context.cacheDir, "app-update").apply { mkdirs() }
      val apk = File(dir, "syrnike13.apk")
      download(url, apk)
      if (!hex(apk).equals(sha256, ignoreCase = true)) {
        apk.delete()
        throw CodedException("ERR_APP_UPDATE_CHECKSUM", "Downloaded APK does not match its checksum", null)
      }
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.appupdate", apk)
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }
  }

  private fun download(url: String, target: File) {
    val connection = URL(url).openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = 15_000
      connection.readTimeout = 60_000
      if (connection.responseCode != HttpURLConnection.HTTP_OK) {
        throw CodedException("ERR_APP_UPDATE_DOWNLOAD", "APK download failed: HTTP ${connection.responseCode}", null)
      }
      connection.inputStream.use { input -> target.outputStream().use { input.copyTo(it) } }
    } finally {
      connection.disconnect()
    }
  }

  private fun hex(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(1 shl 16)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }
}
