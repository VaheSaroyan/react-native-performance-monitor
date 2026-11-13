const path = require('path');

/**
 * Autolinking configuration.
 *
 * Note the two different path conventions, which are not interchangeable:
 * the CLI uses `podspecPath` as given, so it must be absolute, while it
 * resolves `sourceDir` with `path.join(packageRoot, sourceDir)`, so an
 * absolute value there produces a nonexistent directory and Android silently
 * fails to link.
 */
module.exports = {
  dependency: {
    platforms: {
      ios: {
        podspecPath: path.join(__dirname, 'RNPerfSDK.podspec'),
      },
      android: {
        sourceDir: 'android',
        packageImportPath: 'import com.rnperf.sdk.RNPerfFrameMonitorPackage;',
        packageInstance: 'new RNPerfFrameMonitorPackage()',
      },
    },
  },
};
