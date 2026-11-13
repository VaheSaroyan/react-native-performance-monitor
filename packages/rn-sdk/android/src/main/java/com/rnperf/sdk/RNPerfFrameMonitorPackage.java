package com.rnperf.sdk;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Registers the frame monitor. Found automatically by React Native autolinking.
 *
 * Uses the eager {@code ReactPackage} API rather than {@code BaseReactPackage}:
 * the latter only exists from React Native 0.74, and this package supports 0.70
 * upwards. The eager form is deprecated but still honoured on every version,
 * including the bridgeless runtime, and one module is not worth the lazy path.
 */
// `rawtypes` is unavoidable: ReactPackage declares a raw List<ViewManager>, so
// a parameterised override would not match the interface.
@SuppressWarnings({"deprecation", "rawtypes"})
public class RNPerfFrameMonitorPackage implements ReactPackage {

  @Override
  public List<NativeModule> createNativeModules(ReactApplicationContext context) {
    List<NativeModule> modules = new ArrayList<>();
    modules.add(new RNPerfFrameMonitorModule(context));
    return modules;
  }

  @Override
  public List<ViewManager> createViewManagers(ReactApplicationContext context) {
    return Collections.emptyList();
  }
}
