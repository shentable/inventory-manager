package com.sandwich.inventory

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** 使用 Android Keystore 包装 Token 密钥和备份恢复口令。 */
object SecureStore {
    private const val ALIAS = "sandwich_node_secrets_v1"
    private const val PREFS = "node_secrets"

    fun put(context: Context, name: String, value: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val packed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        context.getSharedPreferences(PREFS, 0).edit()
            .putString(name, Base64.encodeToString(packed, Base64.NO_WRAP)).apply()
    }
    fun get(context: Context, name: String): String? {
        val encoded = context.getSharedPreferences(PREFS, 0).getString(name, null) ?: return null
        return runCatching {
        val packed = Base64.decode(encoded, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, packed.copyOfRange(0, 12)))
        String(cipher.doFinal(packed.copyOfRange(12, packed.size)), Charsets.UTF_8)
        }.getOrNull()
    }
    fun remove(context: Context, name: String) {
        context.getSharedPreferences(PREFS, 0).edit().remove(name).apply()
    }
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
    }
}
