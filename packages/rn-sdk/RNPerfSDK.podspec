require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "RNPerfSDK"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.license      = "MIT"
  s.authors      = "rnperf"
  s.homepage     = "https://github.com/rnperf/react-native-performance-monitor"
  s.platforms    = { :ios => "13.0" }
  s.source       = { :path => "." }
  s.source_files = "ios/**/*.{h,m}"
  s.frameworks   = "UIKit", "QuartzCore"

  # React-Core brings in RCTBridgeModule. The module is a classic bridge module,
  # which the new architecture still supports through its interop layer, so one
  # implementation covers both the old and the bridgeless runtime.
  s.dependency "React-Core"
end
