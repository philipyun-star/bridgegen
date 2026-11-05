plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.bridgegen.pingpoc"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.example.bridgegen.pingpoc"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    // ← bridgegen이 만든 Maven 아티팩트. 생성 코드(BridgeContract.kt) + NativeBridgeRouter + webkit/serialization 의존성이 같이 온다.
    implementation("com.example:ping-bridge:${providers.gradleProperty("bridgegen.version").getOrElse("1.0.0")}")
    implementation("androidx.activity:activity-ktx:1.9.3")
}
