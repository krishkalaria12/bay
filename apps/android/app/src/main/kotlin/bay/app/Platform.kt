package bay.app

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import bay.core.HttpClient
import bay.core.HttpException
import bay.core.HttpRequest
import bay.core.HttpResponse
import bay.core.SecretStore
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** The core's HTTP requests, through HttpURLConnection: the phone's own certificates, proxies and VPN. */
class UrlConnectionHttp : HttpClient {
    override suspend fun send(request: HttpRequest): HttpResponse = withContext(Dispatchers.IO) {
        try {
            val connection = URL(request.url).openConnection() as HttpURLConnection
            connection.requestMethod = request.method
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            request.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            request.body?.let { body ->
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { it.write(body) }
            }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val body = stream?.use { it.readBytes() } ?: ByteArray(0)
            connection.disconnect()
            HttpResponse(status.toUShort(), body)
        } catch (error: IOException) {
            throw HttpException.Offline(error.message ?: "no answer")
        }
    }

    private companion object {
        const val TIMEOUT_MS = 20_000
    }
}

/**
 * The chain's key in the Android keystore, stored as expo-secure-store stores it: an AES-GCM item in the `SecureStore`
 * preferences under `key_v1-<key>`, sealed with the keystore key `AES/GCM/NoPadding:key_v1:keystoreUnauthenticated`.
 * So the key the Expo app kept is read after the native app installs over it.
 */
class KeystoreSecrets(context: Context) : SecretStore {
    private val prefs: SharedPreferences = context.getSharedPreferences("SecureStore", Context.MODE_PRIVATE)
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun entry(key: String) = "key_v1-$key"

    private fun secretKey(alias: String, create: Boolean): SecretKey? {
        (keyStore.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        if (!create) return null
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(spec)
            generateKey()
        }
    }

    override fun read(key: String): String? = runCatching {
        val item = JSONObject(prefs.getString(entry(key), null) ?: return null)
        if (item.optString("scheme") != "aes") return null
        val alias = if (item.optBoolean("usesKeystoreSuffix")) SUFFIXED_ALIAS else ALIAS
        val secret = secretKey(alias, create = false) ?: return null
        val cipher = Cipher.getInstance(CIPHER)
        cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(item.getInt("tlen"), Base64.decode(item.getString("iv"), Base64.DEFAULT)))
        String(cipher.doFinal(Base64.decode(item.getString("ct"), Base64.DEFAULT)), Charsets.UTF_8)
    }.getOrNull()

    override fun write(key: String, value: String) {
        val secret = secretKey(SUFFIXED_ALIAS, create = true) ?: return
        val cipher = Cipher.getInstance(CIPHER)
        cipher.init(Cipher.ENCRYPT_MODE, secret)
        val spec = cipher.parameters.getParameterSpec(GCMParameterSpec::class.java)
        val item = JSONObject()
            .put("ct", Base64.encodeToString(cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP))
            .put("iv", Base64.encodeToString(spec.iv, Base64.NO_WRAP))
            .put("tlen", spec.tLen)
            .put("scheme", "aes")
            .put("usesKeystoreSuffix", true)
        prefs.edit().putString(entry(key), item.toString()).apply()
    }

    override fun delete(key: String) {
        prefs.edit().remove(entry(key)).apply()
    }

    private companion object {
        const val CIPHER = "AES/GCM/NoPadding"
        const val ALIAS = "$CIPHER:key_v1"
        const val SUFFIXED_ALIAS = "$ALIAS:keystoreUnauthenticated"
    }
}
