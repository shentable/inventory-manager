plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.sandwich.inventory"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.sandwich.inventory"
        minSdk = 29
        targetSdk = 34
        versionCode = 18
        versionName = "1.9.0-shantech-brand"

        ndk {
            abiFilters += setOf("arm64-v8a")
        }

        // 组网参数编译期注入（门店批量装机时店员零配置）：
        //   在 local.properties / gradle.properties 设置 EASYTIER_*，或通过环境变量
        //   SANDWICH_EASYTIER_NETWORK_NAME / SANDWICH_EASYTIER_NETWORK_SECRET /
        //   SANDWICH_EASYTIER_PEERS 注入。
        // 安全提示：注入后任何拿到 APK 的人都能提取该密码，仅限店内设备使用场景。
        fun prop(name: String): String =
            (project.findProperty(name) as String?)
                ?: System.getenv("SANDWICH_$name")
                ?: System.getenv(name)
                ?: ""
        fun esc(s: String): String = s.replace("\\", "\\\\").replace("\"", "\\\"")
        buildConfigField("String", "EASYTIER_NETWORK_NAME", "\"${esc(prop("EASYTIER_NETWORK_NAME"))}\"")
        buildConfigField("String", "EASYTIER_NETWORK_SECRET", "\"${esc(prop("EASYTIER_NETWORK_SECRET"))}\"")
        buildConfigField("String", "EASYTIER_PEERS", "\"${esc(prop("EASYTIER_PEERS"))}\"")
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"${esc(prop("DEFAULT_SERVER_URL").ifBlank { "http://10.126.126.1:8000" })}\"")
    }

    signingConfigs {
        create("release") {
            val storePath = System.getenv("SANDWICH_RELEASE_STORE_FILE")
            if (!storePath.isNullOrBlank()) {
                storeFile = file(storePath)
                storePassword = System.getenv("SANDWICH_RELEASE_STORE_PASSWORD")
                keyAlias = System.getenv("SANDWICH_RELEASE_KEY_ALIAS")
                keyPassword = System.getenv("SANDWICH_RELEASE_KEY_PASSWORD")
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        jniLibs {
            // 内置 easytier-core 可执行文件（伪装为 lib*.so）需要提取到文件系统
            // 才能被执行；关闭「从 APK 内直接映射 so」的优化
            useLegacyPackaging = true
        }
    }

    buildTypes {
        release {
            // 壳 App 无敏感业务代码，默认不混淆；如需开启请补充规则（见 proguard-rules.pro）
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            if (!System.getenv("SANDWICH_RELEASE_STORE_FILE").isNullOrBlank()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
}

tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    doFirst {
        val native = file("src/main/jniLibs/arm64-v8a/libsandwichserver.so")
        check(native.isFile) {
            "release APK 缺少 Android 原生后端；请先运行 android/native-server/build-server.sh"
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    // WebView 进程级代理（ProxyController）：内嵌组网时把流量送入内核 socks5
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.documentfile)
    testImplementation(libs.junit)

    // 内嵌 EasyTier：内核可执行文件不通过 Maven 依赖，而是按 ABI 放入
    // app/src/main/jniLibs/<abi>/libeasytiercore.so（构建脚本 android/easytier/build-core.sh）
}
