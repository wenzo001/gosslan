# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# GOSSLAN_JNI_BEGIN
# Rust 用 JNI「名字 + 签名」直接调这些 Kotlin 方法（见 src-tauri/src/transport/ble_android.rs
# 里的 `kotlin_method!`）。release 构建会开 R8（`build.gradle.kts` 的 `isMinifyEnabled = true`），
# **实测**：不 keep 的话它们会被改名成 a/b/c/d/e —— debug 包不混淆，所以这个坑只在
# release 真机包上以 NoSuchMethodError 现形（蓝牙外设这条路径整个失效，日志里也没有线索）。
# 新增 JNI 方法时必须在这里补一行；护栏测试
# `release_keeps_every_kotlin_method_called_from_rust` 会盯着这件事。
-keep class com.gosslan.app.BlePeripheral {
    public void stop();
    public boolean start();
    public boolean isConnected(java.lang.String);
    public int payloadMtu(java.lang.String);
    public boolean send(java.lang.String, byte[]);
    public void requestAllPermissions();
    public boolean hasRequiredPermissions();
    native <methods>;
}
# GOSSLAN_JNI_END
