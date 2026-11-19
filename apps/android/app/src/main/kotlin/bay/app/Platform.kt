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

/**
 * The core's HTTP requests, through HttpURLConnection: the phone's own certificates, proxies and VPN. Redirects are
 * followed here rather than by the connection, which won't cross between http and https.
 */
class UrlConnectionHttp : HttpClient {
    override suspend fun send(request: HttpRequest): HttpResponse = withContext(Dispatchers.IO) {
        try {
            var url = URL(request.url)
            var method = request.method
            var body = request.body
            var answer = once(url, method, request, body)
            var hops = 0
            while (request.followRedirects && answer.status.toInt() in 300..399 && hops < MAX_HOPS) {
                val location = answer.headers["location"] ?: break
                val status = answer.status.toInt()
                url = URL(url, location)
                hops += 1
                // A 303, and a 301 or 302 after a POST, come back as GET without the body, as browsers do.
                if (status == 303 || (method == "POST" && (status == 301 || status == 302))) {
                    method = "GET"
                    body = null
                }
                answer = once(url, method, request, body)
            }
            answer
        } catch (error: IOException) {
            throw HttpException.Offline(error.message ?: "no answer")
        }
    }

    private fun once(url: URL, method: String, request: HttpRequest, body: ByteArray?): HttpResponse {
        val connection = url.openConnection() as HttpURLConnection
        val timeout = request.timeoutMs?.toInt()?.coerceAtLeast(1) ?: TIMEOUT_MS
        connection.instanceFollowRedirects = false
        connection.requestMethod = method
        connection.connectTimeout = timeout
        connection.readTimeout = timeout
        request.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
        body?.let {
            connection.doOutput = true
            connection.setFixedLengthStreamingMode(it.size)
            connection.outputStream.use { stream -> stream.write(it) }
        }
        try {
            val status = connection.responseCode
            val headers = connection.headerFields.orEmpty()
                .mapNotNull { (name, values) -> name?.let { it.lowercase() to values.joinToString(", ") } }
                .toMap()
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val bytes = stream?.use { it.readBytes() } ?: ByteArray(0)
            return HttpResponse(status.toUShort(), url.toString(), headers, bytes)
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val TIMEOUT_MS = 20_000
        const val MAX_HOPS = 20
    }
}

/**
 * Secrets (the chain's key, saved sign-ins) sealed with an AES-GCM key that never leaves the Android keystore, kept in
 * the `bay-secrets` preferences as the ciphertext and its IV.
 */
class KeystoreSecrets(context: Context) : SecretStore {
    private val prefs: SharedPreferences = context.getSharedPreferences("bay-secrets", Context.MODE_PRIVATE)
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun secretKey(create: Boolean): SecretKey? {
        (keyStore.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        if (!create) return null
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
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
        val item = JSONObject(prefs.getString(key, null) ?: return null)
        val secret = secretKey(create = false) ?: return null
        val cipher = Cipher.getInstance(CIPHER)
        cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(TAG_BITS, Base64.decode(item.getString("iv"), Base64.NO_WRAP)))
        String(cipher.doFinal(Base64.decode(item.getString("ct"), Base64.NO_WRAP)), Charsets.UTF_8)
    }.getOrNull()

    override fun write(key: String, value: String) {
        val secret = secretKey(create = true) ?: return
        val cipher = Cipher.getInstance(CIPHER)
        cipher.init(Cipher.ENCRYPT_MODE, secret)
        val item = JSONObject()
            .put("ct", Base64.encodeToString(cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP))
            .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
        prefs.edit().putString(key, item.toString()).apply()
    }

    override fun delete(key: String) {
        prefs.edit().remove(key).apply()
    }

    private companion object {
        const val CIPHER = "AES/GCM/NoPadding"
        const val ALIAS = "bay-secrets"
        const val TAG_BITS = 128
    }
}
