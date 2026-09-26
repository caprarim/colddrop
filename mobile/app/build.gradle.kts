import java.util.Properties

plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
val signing = Properties().apply { val f = rootProject.file("signing.properties"); if (f.exists()) f.inputStream().use { load(it) } }
android {
    namespace = "com.caprarim.colddrop"
    compileSdk = 36
    defaultConfig { applicationId = "com.caprarim.colddrop"; minSdk = 29; targetSdk = 35; versionCode = 4; versionName = "1.3.0" }
    signingConfigs { create("release") { storeFile = rootProject.file(signing.getProperty("storeFile", "release.jks")); storePassword = signing.getProperty("storePassword"); keyAlias = "colddrop"; keyPassword = signing.getProperty("keyPassword") } }
    buildTypes { release { isMinifyEnabled = false; signingConfig = signingConfigs.getByName("release") } }
    lint { checkReleaseBuilds = false }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    sourceSets["main"].apply { manifest.srcFile("AndroidManifest.xml"); java.setSrcDirs(listOf("public/src")); res.setSrcDirs(listOf("res")); assets.setSrcDirs(listOf("assets")) }
}
dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
