#import <React/RCTBridgeModule.h>

/**
 * Samples the iOS UI thread's real frame cadence with CADisplayLink.
 *
 * This is the one metric no off-device tool can reach: a simulator exposes no
 * Core Animation frame stats, and reading them from a physical device needs an
 * Instruments GUI trace. The display link runs in the app's own process, so it
 * works identically on a simulator and on real hardware.
 *
 * Frames are counted natively and drained once per reporting interval rather
 * than emitted per frame — a bridge event every frame would itself cause the
 * jank this is supposed to measure.
 */
@interface RNPerfFrameMonitor : NSObject <RCTBridgeModule>
@end
