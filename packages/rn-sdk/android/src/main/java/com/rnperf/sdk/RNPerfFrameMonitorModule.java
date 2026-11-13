package com.rnperf.sdk;

import android.app.Activity;
import android.content.Context;
import android.os.Build;
import android.os.Debug;
import android.view.Choreographer;
import android.view.Display;
import android.view.WindowManager;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.LifecycleEventListener;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.UiThreadUtil;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.module.annotations.ReactModule;

import java.util.Arrays;

/**
 * Samples the Android UI thread's frame cadence with Choreographer.
 *
 * The daemon already reads richer per-frame data over adb when a cable is
 * attached. This exists for the case adb cannot reach: a physical device on
 * Wi-Fi, a tester's phone, or CI where only the app itself reports back. It is
 * the same measurement the iOS module makes, so the two platforms produce
 * directly comparable numbers.
 *
 * Reposting a frame callback each frame schedules the next vsync, so the loop
 * runs at the display's cadence even when nothing on screen changes — the same
 * approach React Native's own FPS monitor uses.
 */
@ReactModule(name = RNPerfFrameMonitorModule.NAME)
public class RNPerfFrameMonitorModule extends ReactContextBaseJavaModule
    implements LifecycleEventListener, Choreographer.FrameCallback {

  public static final String NAME = "RNPerfFrameMonitor";

  /**
   * At 120Hz this is five seconds of frames. If JavaScript is blocked for
   * longer it is not draining us either, and an unbounded buffer would grow
   * while the app is already in trouble.
   */
  private static final int MAX_BUFFERED_FRAMES = 600;

  /**
   * An interval beyond this many refresh periods counts as a dropped frame.
   * Inter-frame deltas straddle the budget at steady state, so an exact
   * comparison would flag ordinary vsync jitter.
   */
  private static final double JANK_FACTOR = 1.5;

  private static final double NANOS_PER_MS = 1_000_000.0;
  private static final double BYTES_PER_MB = 1024.0 * 1024.0;

  private final double[] intervalsMs = new double[MAX_BUFFERED_FRAMES];
  private int intervalCount = 0;
  private int overflowedFrames = 0;
  private int droppedFrames = 0;

  private long lastFrameTimeNanos = 0L;
  private long windowStartNanos = 0L;
  private double refreshHz = 60.0;

  /** The app asked us to measure. Survives a pause, unlike {@link #running}. */
  private boolean enabled = false;
  /** A frame callback is currently scheduled. */
  private boolean running = false;
  private boolean listening = false;

  public RNPerfFrameMonitorModule(ReactApplicationContext context) {
    super(context);
    // Deliberately no listener registration here: handing `this` to the context
    // from a constructor publishes a reference to a half-built object. Nothing
    // needs lifecycle events until measurement actually starts.
  }

  @Override
  public String getName() {
    return NAME;
  }

  /* ------------------------------------------------------------- exported */

  @ReactMethod
  public void start() {
    UiThreadUtil.runOnUiThread(new Runnable() {
      @Override
      public void run() {
        enabled = true;
        if (!listening) {
          getReactApplicationContext().addLifecycleEventListener(RNPerfFrameMonitorModule.this);
          listening = true;
        }
        startLoop();
      }
    });
  }

  @ReactMethod
  public void stop() {
    UiThreadUtil.runOnUiThread(new Runnable() {
      @Override
      public void run() {
        enabled = false;
        stopLoop();
      }
    });
  }

  /**
   * Returns the window accumulated since the previous call and starts a new
   * one. Resolved from the UI thread so the frame buffers are only ever
   * touched by one thread, with no locking on the hot path.
   */
  @ReactMethod
  public void getMetrics(final Promise promise) {
    UiThreadUtil.runOnUiThread(new Runnable() {
      @Override
      public void run() {
        try {
          promise.resolve(buildMetrics());
        } catch (Exception error) {
          promise.reject("E_RNPERF_METRICS", error);
        }
      }
    });
  }

  @ReactMethod
  public void isAvailable(Promise promise) {
    promise.resolve(Boolean.TRUE);
  }

  /* ------------------------------------------------------------ collection */

  private WritableMap buildMetrics() {
    WritableMap result = Arguments.createMap();
    result.putDouble("refreshHz", refreshHz);
    putMemory(result);

    if (!running || windowStartNanos == 0L) {
      return result;
    }

    long now = System.nanoTime();
    double elapsedMs = (now - windowStartNanos) / NANOS_PER_MS;
    int frames = intervalCount + overflowedFrames;

    // Too short a window makes frames-per-second meaningless.
    if (elapsedMs < 100.0 || frames == 0) {
      return result;
    }

    result.putInt("framesRendered", frames);
    result.putDouble("uiFps", Math.min(refreshHz, frames / (elapsedMs / 1000.0)));

    if (intervalCount > 0) {
      double[] sorted = Arrays.copyOf(intervalsMs, intervalCount);
      Arrays.sort(sorted);
      result.putDouble("frameP50Ms", quantile(sorted, 0.50));
      result.putDouble("frameP95Ms", quantile(sorted, 0.95));
      result.putDouble("frameP99Ms", quantile(sorted, 0.99));
    }

    // Express jank as a share of the frames the display could have shown,
    // rather than of the ones it managed to.
    double expected = (elapsedMs / 1000.0) * refreshHz;
    if (expected >= 1.0) {
      double jank = (droppedFrames / expected) * 100.0;
      result.putDouble("jankPercent", Math.max(0.0, Math.min(100.0, jank)));
    }

    resetWindow();
    return result;
  }

  /**
   * Java and native heap only. Proportional set size would be the better
   * number, but {@code Debug.getMemoryInfo} takes well over a frame to return
   * and would cause the jank this module exists to measure. The daemon reads
   * PSS over adb instead, when a cable is attached.
   */
  private void putMemory(WritableMap result) {
    try {
      Runtime runtime = Runtime.getRuntime();
      double javaHeapMB = (runtime.totalMemory() - runtime.freeMemory()) / BYTES_PER_MB;
      result.putDouble("javaHeapMB", javaHeapMB);
      result.putDouble("nativeHeapMB", Debug.getNativeHeapAllocatedSize() / BYTES_PER_MB);
    } catch (Throwable ignored) {
      // Memory is a bonus here; never fail a frame report over it.
    }
  }

  /* --------------------------------------------------------- frame callback */

  @Override
  public void doFrame(long frameTimeNanos) {
    if (!running) {
      return;
    }

    if (lastFrameTimeNanos == 0L) {
      // First callback after start or resume: there is no previous frame to
      // measure against, and the gap would read as an enormous stall.
      lastFrameTimeNanos = frameTimeNanos;
      Choreographer.getInstance().postFrameCallback(this);
      return;
    }

    double intervalMs = (frameTimeNanos - lastFrameTimeNanos) / NANOS_PER_MS;
    lastFrameTimeNanos = frameTimeNanos;

    if (intervalMs > 0.0) {
      double budgetMs = 1000.0 / refreshHz;
      if (intervalMs > budgetMs * JANK_FACTOR) {
        // One long interval can swallow several refreshes; count each.
        int missed = (int) Math.round(intervalMs / budgetMs) - 1;
        droppedFrames += Math.max(1, missed);
      }
      if (intervalCount < MAX_BUFFERED_FRAMES) {
        intervalsMs[intervalCount++] = intervalMs;
      } else {
        // Still count it towards FPS once the buffer is full, so a long JS
        // stall does not make the app look idle.
        overflowedFrames++;
      }
    }

    Choreographer.getInstance().postFrameCallback(this);
  }

  /* -------------------------------------------------------------- lifecycle */

  @Override
  public void onHostResume() {
    if (enabled) {
      startLoop();
    }
  }

  @Override
  public void onHostPause() {
    // A backgrounded app receives no frames. Left running, the next window
    // would report zero FPS and a stall of however long it was away.
    stopLoop();
  }

  @Override
  public void onHostDestroy() {
    enabled = false;
    stopLoop();
    if (listening) {
      getReactApplicationContext().removeLifecycleEventListener(this);
      listening = false;
    }
  }

  /* ---------------------------------------------------------------- helpers */

  private void startLoop() {
    if (running) {
      return;
    }
    refreshHz = readRefreshHz();
    lastFrameTimeNanos = 0L;
    resetWindow();
    running = true;
    Choreographer.getInstance().postFrameCallback(this);
  }

  private void stopLoop() {
    if (!running) {
      return;
    }
    running = false;
    Choreographer.getInstance().removeFrameCallback(this);
    lastFrameTimeNanos = 0L;
  }

  private void resetWindow() {
    intervalCount = 0;
    overflowedFrames = 0;
    droppedFrames = 0;
    windowStartNanos = System.nanoTime();
  }

  /**
   * The display's current mode, not its maximum: a 120Hz panel running at 60Hz
   * has a 16.7ms budget, and holding it to 8.3ms would invent jank.
   */
  @SuppressWarnings("deprecation")
  private double readRefreshHz() {
    try {
      Display display = null;

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        Activity activity = getCurrentActivity();
        if (activity != null) {
          display = activity.getDisplay();
        }
      }

      if (display == null) {
        Context context = getReactApplicationContext();
        WindowManager windowManager =
            (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        if (windowManager != null) {
          display = windowManager.getDefaultDisplay();
        }
      }

      if (display != null) {
        float hz = display.getRefreshRate();
        if (hz > 20.0f) {
          // The platform reports values like 60.000003814697266; two decimals
          // is well beyond what any frame budget needs.
          return Math.round(hz * 100.0) / 100.0;
        }
      }
    } catch (Throwable ignored) {
      // Fall through to the safe default below.
    }
    return 60.0;
  }

  private static double quantile(double[] sortedAscending, double q) {
    int n = sortedAscending.length;
    if (n == 0) {
      return 0.0;
    }
    if (n == 1) {
      return sortedAscending[0];
    }
    double position = (n - 1) * q;
    int low = (int) Math.floor(position);
    int high = (int) Math.ceil(position);
    double a = sortedAscending[low];
    double b = sortedAscending[high];
    return low == high ? a : a + (b - a) * (position - low);
  }
}
