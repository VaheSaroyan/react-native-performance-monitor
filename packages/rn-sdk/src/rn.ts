/**
 * Access to React Native's own modules.
 *
 * A literal `require` is what Metro resolves at build time; `global.require`
 * is Metro's internal numeric-id loader and does not take module names, so
 * reaching for it silently yields undefined inside a real bundle. The
 * try/catch keeps the package importable outside React Native (tests, tooling)
 * where the peer dependency is absent.
 */

declare const require: ((id: string) => any) | undefined;

/**
 * `react-native` is the only module this package requires, and deliberately so.
 *
 * Metro resolves `require` at build time by scanning for string literals, which
 * cuts both ways: `require(someVariable)` resolves to nothing at runtime, while
 * a literal require of an optional package FAILS THE WHOLE BUNDLE when that
 * module is absent — a try/catch cannot rescue a build-time resolution error.
 * So there are no optional requires here; optional things are detected through
 * globals and the native module registry instead.
 *
 * The try/catch only covers use outside React Native, such as tests.
 */
const RN = (() => {
  try {
    return typeof require === 'function' ? require('react-native') : undefined;
  } catch {
    return undefined;
  }
})();

export interface NativeModuleRegistry {
  [name: string]: any;
}

export const NativeModules: NativeModuleRegistry = RN?.NativeModules ?? {};

export const Platform: { OS: string; constants?: any } = RN?.Platform ?? { OS: 'unknown' };

export const isReactNative = Boolean(RN);

/**
 * React Native's batched bridge instance, used to count calls crossing it.
 * Reached through the global rather than by importing MessageQueue, so a
 * future reshuffle of React Native's internals cannot break the bundle.
 */
export function getBatchedBridge(): any {
  return (globalThis as any).__fbBatchedBridge;
}

/**
 * Whether this looks like an Expo runtime. Detected through globals and the
 * module registry, never by requiring an Expo package: that package is absent
 * in a bare app and a literal require of it would fail the build there.
 */
export function isExpoRuntime(): boolean {
  const g = globalThis as any;
  if (g.expo || g.__expo || g.ExpoModules) return true;
  return Boolean(NativeModules.ExponentConstants || NativeModules.NativeUnimoduleProxy);
}

/** The app's own bundle id, where a module that exposes it is installed. */
export function inferBundleId(): string | undefined {
  return (
    NativeModules.RNDeviceInfo?.bundleId ??
    NativeModules.SettingsManager?.settings?.CFBundleIdentifier ??
    undefined
  );
}

/**
 * Metro's bundle URL is the most reliable way to find the dev machine.
 *
 * Only an http(s) bundle URL identifies one: an app running an embedded bundle
 * reports something like `assets://index.android.bundle`, whose "host" is a
 * filename. Connecting to that would fail silently, so treat it as unknown and
 * let the caller pass a host.
 */
export function inferHost(): string | undefined {
  const source = NativeModules.SourceCode;
  const scriptURL: string | undefined = source?.getConstants?.().scriptURL ?? source?.scriptURL;
  if (!scriptURL) return undefined;

  const match = /^(https?):\/\/([^/:]+)/i.exec(scriptURL);
  const host = match?.[2];
  if (!host) return undefined;

  // An Android emulator reaches the host machine through this alias.
  if (host === 'localhost' || host === '127.0.0.1') {
    return Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
  }
  return host;
}
