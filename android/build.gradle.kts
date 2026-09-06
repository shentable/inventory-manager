// 根构建脚本：仅声明插件版本（不在此应用），各模块按需 alias 使用
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
}
