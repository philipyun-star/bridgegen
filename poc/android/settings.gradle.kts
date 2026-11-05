// bridgegen PoC (Android): bridgegen이 배포한 로컬 Maven 저장소에서 com.example:ping-bridge 를 받아 쓴다.
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        // bridgegen build 가 만든 로컬 Maven 저장소 (사내 Nexus · GitHub Packages 로 바꿔도 같은 좌표로 받는다)
        maven { url = uri(providers.gradleProperty("bridgegen.repo").getOrElse("${rootDir}/../../examples/ping/out/maven")) }
    }
}
rootProject.name = "PingPoC"
include(":app")
