#import "RNPerfFrameMonitor.h"

#import <QuartzCore/QuartzCore.h>
#import <UIKit/UIKit.h>
#import <mach/mach.h>
#import <mach/task_info.h>

/**
 * Cap on buffered frame intervals. At 120Hz this is five seconds of frames;
 * if JavaScript is blocked for longer than that it will not be polling us
 * either, and an unbounded buffer would grow while the app is already in
 * trouble.
 */
static const NSUInteger RNPerfMaxBufferedFrames = 600;

/**
 * An interval longer than this many refresh periods counts as a dropped frame.
 * Inter-frame deltas sit a hair either side of the budget at steady state, so
 * comparing against the budget exactly would flag ordinary vsync jitter.
 */
static const double RNPerfJankFactor = 1.5;

@implementation RNPerfFrameMonitor {
  CADisplayLink *_displayLink;
  NSMutableArray<NSNumber *> *_intervalsMs;
  CFTimeInterval _lastTimestamp;
  CFTimeInterval _windowStart;
  NSUInteger _droppedFrames;
  NSUInteger _overflowedFrames;
  double _refreshHz;
  BOOL _running;
}

RCT_EXPORT_MODULE(RNPerfFrameMonitor)

/**
 * CADisplayLink must be created and invalidated on the main thread, and the
 * callback fires there too. Running every exported method on the main queue
 * means the buffers below are only ever touched from one thread, with no lock.
 */
- (dispatch_queue_t)methodQueue {
  return dispatch_get_main_queue();
}

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

- (instancetype)init {
  if (self = [super init]) {
    _intervalsMs = [NSMutableArray arrayWithCapacity:RNPerfMaxBufferedFrames];
    _refreshHz = 60.0;
    _lastTimestamp = 0;
    _windowStart = 0;
  }
  return self;
}

- (void)dealloc {
  [self teardown];
}

#pragma mark - Exported

RCT_EXPORT_METHOD(start) {
  if (_running) {
    return;
  }
  _running = YES;

  // ProMotion displays run at up to 120Hz, so the frame budget is 8.3ms there,
  // not 16.7ms. Reading the real figure keeps "janky" honest on every device.
  NSInteger maxFps = UIScreen.mainScreen.maximumFramesPerSecond;
  _refreshHz = maxFps > 0 ? (double)maxFps : 60.0;

  [self resetWindow];
  _lastTimestamp = 0;

  _displayLink = [CADisplayLink displayLinkWithTarget:self selector:@selector(onFrame:)];

  // Common modes keeps the link firing while a scroll view is tracking a drag.
  // The default mode would go quiet during exactly the interaction whose jank
  // we most want to catch.
  [_displayLink addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];

  [NSNotificationCenter.defaultCenter addObserver:self
                                         selector:@selector(onBackground)
                                             name:UIApplicationDidEnterBackgroundNotification
                                           object:nil];
  [NSNotificationCenter.defaultCenter addObserver:self
                                         selector:@selector(onForeground)
                                             name:UIApplicationWillEnterForegroundNotification
                                           object:nil];
}

RCT_EXPORT_METHOD(stop) {
  [self teardown];
}

/**
 * Returns the window accumulated since the previous call and starts a new one.
 */
RCT_EXPORT_METHOD(getMetrics:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject) {
  NSMutableDictionary *result = [NSMutableDictionary dictionary];

  result[@"refreshHz"] = @(_refreshHz);

  double footprintMB = [self physicalFootprintMB];
  if (footprintMB >= 0) {
    result[@"memoryMB"] = @(footprintMB);
  }

  if (!_running) {
    resolve(result);
    return;
  }

  CFTimeInterval now = CACurrentMediaTime();
  double elapsedMs = (now - _windowStart) * 1000.0;
  NSUInteger frames = _intervalsMs.count + _overflowedFrames;

  // Too short a window makes frames-per-second meaningless.
  if (elapsedMs < 100.0 || frames == 0) {
    resolve(result);
    return;
  }

  result[@"framesRendered"] = @(frames);
  result[@"uiFps"] = @(MIN(_refreshHz, (double)frames / (elapsedMs / 1000.0)));

  if (_intervalsMs.count > 0) {
    NSArray<NSNumber *> *sorted = [_intervalsMs sortedArrayUsingSelector:@selector(compare:)];
    result[@"frameP50Ms"] = @([RNPerfFrameMonitor quantile:sorted at:0.50]);
    result[@"frameP95Ms"] = @([RNPerfFrameMonitor quantile:sorted at:0.95]);
    result[@"frameP99Ms"] = @([RNPerfFrameMonitor quantile:sorted at:0.99]);
  }

  // Expected frames for the window, so the percentage is of what the display
  // could have shown rather than of what it managed to.
  double expected = (elapsedMs / 1000.0) * _refreshHz;
  if (expected >= 1.0) {
    double jank = ((double)_droppedFrames / expected) * 100.0;
    result[@"jankPercent"] = @(MIN(100.0, MAX(0.0, jank)));
  }

  [self resetWindow];
  resolve(result);
}

RCT_EXPORT_METHOD(isAvailable:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject) {
  resolve(@YES);
}

#pragma mark - Display link

- (void)onFrame:(CADisplayLink *)link {
  if (_lastTimestamp <= 0) {
    // First callback after start or resume: there is no previous frame to
    // measure against, and the gap would be reported as an enormous stall.
    _lastTimestamp = link.timestamp;
    return;
  }

  double intervalMs = (link.timestamp - _lastTimestamp) * 1000.0;
  _lastTimestamp = link.timestamp;

  if (intervalMs <= 0) {
    return;
  }

  double budgetMs = 1000.0 / _refreshHz;
  if (intervalMs > budgetMs * RNPerfJankFactor) {
    // One interval can swallow several refreshes; count every missed one.
    NSUInteger missed = (NSUInteger)llround(intervalMs / budgetMs) - 1;
    _droppedFrames += MAX((NSUInteger)1, missed);
  }

  if (_intervalsMs.count < RNPerfMaxBufferedFrames) {
    [_intervalsMs addObject:@(intervalMs)];
  } else {
    // Still count the frame towards FPS even once the buffer is full, so a
    // long JS stall does not make the app look idle.
    _overflowedFrames += 1;
  }
}

- (void)onBackground {
  // A backgrounded app stops receiving frames entirely. Left running, the next
  // window would report zero FPS and a multi-second stall that never happened.
  _displayLink.paused = YES;
}

- (void)onForeground {
  _lastTimestamp = 0;
  [self resetWindow];
  _displayLink.paused = NO;
}

#pragma mark - Helpers

- (void)resetWindow {
  [_intervalsMs removeAllObjects];
  _droppedFrames = 0;
  _overflowedFrames = 0;
  _windowStart = CACurrentMediaTime();
}

- (void)teardown {
  _running = NO;
  [_displayLink invalidate];
  _displayLink = nil;
  [NSNotificationCenter.defaultCenter removeObserver:self];
  [_intervalsMs removeAllObjects];
  _lastTimestamp = 0;
}

/**
 * Physical footprint: the figure Xcode shows as "Memory" and the one the
 * jetsam killer judges. Resident size alone understates an app's real cost.
 */
- (double)physicalFootprintMB {
  task_vm_info_data_t info;
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  kern_return_t result = task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&info, &count);
  if (result != KERN_SUCCESS || count < TASK_VM_INFO_REV1_COUNT) {
    return -1;
  }
  return (double)info.phys_footprint / (1024.0 * 1024.0);
}

+ (double)quantile:(NSArray<NSNumber *> *)sortedAscending at:(double)q {
  NSUInteger n = sortedAscending.count;
  if (n == 0) {
    return 0;
  }
  if (n == 1) {
    return sortedAscending[0].doubleValue;
  }
  double position = (double)(n - 1) * q;
  NSUInteger low = (NSUInteger)floor(position);
  NSUInteger high = (NSUInteger)ceil(position);
  double a = sortedAscending[low].doubleValue;
  double b = sortedAscending[high].doubleValue;
  return low == high ? a : a + (b - a) * (position - (double)low);
}

@end
