package com.otahost

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * 호스트 셸. JS 쪽 App 에 userId 를 initialProps 로 넘긴다.
 *
 * 실제 앱이라면 로그인 id 나 설치 id 가 들어갈 자리다. 이 샘플은 카나리 버킷이
 * 사용자마다 갈리는 것을 확인하려고 실행할 때 값을 바꿀 수 있게 했다.
 *   adb shell am start -n com.otahost/.MainActivity --es userId user-7
 */
class MainActivity : ReactActivity() {

  override fun getMainComponentName(): String = "OtaHost"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
        override fun getLaunchOptions(): Bundle =
            Bundle().apply {
              putString("userId", intent?.getStringExtra("userId") ?: "user-1")
            }
      }
}
