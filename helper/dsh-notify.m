// DSH Notify — a tiny macOS notification helper for dsh-approval-notify.
//
// macOS's scripted `display notification` (osascript) has no click handler, so a
// banner can never bring DSH back to the front. This helper posts the banner from
// its own app bundle and handles the click: it activates the DSH desktop app, or
// opens the advertised web GUI URL when only `dsh web` is running.
//
// It uses UNUserNotificationCenter so macOS records the authorization per bundle
// id and lists the app in System Settings → Notifications.
//
// Usage:
//   dsh-notify --status                       # print authorization, then exit
//   dsh-notify --request                      # ask once, print granted/denied
//   dsh-notify --title T [--subtitle S] [--body B] [--sound Glass]
//              [--activate com.deepseek.dsh] [--url https://...]
//              [--identifier key] [--timeout 120]
//   dsh-notify --activate-now --activate com.deepseek.dsh [--url ...]
//
// The posting process stays alive for `--timeout` seconds so a click can be
// handled, then exits on its own.

#import <Cocoa/Cocoa.h>
#import <UserNotifications/UserNotifications.h>

/// Authorization values printed by `--status`:
/// 0 not determined, 1 denied, 2 authorized, 3 provisional, 4 ephemeral.
static NSString *const kDefaultBundleId = @"com.deepseek.dsh";

@interface DSHNotifyDelegate : NSObject <UNUserNotificationCenterDelegate>
@property (nonatomic, copy) NSString *bundleId;
@property (nonatomic, copy) NSString *url;
- (void)activateTarget;
@end

@implementation DSHNotifyDelegate

- (void)activateTarget {
  if ([self.bundleId length] > 0) {
    NSArray<NSRunningApplication *> *apps =
        [NSRunningApplication runningApplicationsWithBundleIdentifier:self.bundleId];
    for (NSRunningApplication *app in apps) {
      if ([app activateWithOptions:NSApplicationActivateIgnoringOtherApps]) return;
    }
  }
  if ([self.url length] > 0) {
    NSURL *target = [NSURL URLWithString:self.url];
    if (target != nil) [[NSWorkspace sharedWorkspace] openURL:target];
  }
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
  completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList
                    | UNNotificationPresentationOptionSound);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    didReceiveNotificationResponse:(UNNotificationResponse *)response
             withCompletionHandler:(void (^)(void))completionHandler {
  [self activateTarget];
  completionHandler();
  exit(0);
}

@end

/// Read the value that follows `--flag`, or nil when the flag is absent.
static NSString *valueAfter(NSArray<NSString *> *args, NSUInteger *index, NSString *flag) {
  NSString *arg = args[*index];
  if (![arg isEqualToString:flag]) return nil;
  if (*index + 1 >= args.count) return nil;
  *index += 1;
  return args[*index];
}

/// Keep the run loop alive briefly so a completion handler can fire.
static void pump(NSTimeInterval seconds) {
  [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:seconds]];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSMutableArray<NSString *> *args = [NSMutableArray array];
    for (int i = 1; i < argc; i++) {
      [args addObject:[NSString stringWithUTF8String:argv[i]] ?: @""];
    }

    NSString *title = nil;
    NSString *subtitle = nil;
    NSString *body = nil;
    NSString *sound = nil;
    NSString *bundleId = nil;
    NSString *url = nil;
    NSString *identifier = nil;
    NSString *activateNow = nil;
    double timeout = 120.0;

    for (NSUInteger i = 0; i < args.count; i++) {
      NSString *value;
      if ((value = valueAfter(args, &i, @"--title")) != nil) title = value;
      else if ((value = valueAfter(args, &i, @"--subtitle")) != nil) subtitle = value;
      else if ((value = valueAfter(args, &i, @"--body")) != nil) body = value;
      else if ((value = valueAfter(args, &i, @"--sound")) != nil) sound = value;
      else if ((value = valueAfter(args, &i, @"--activate")) != nil) bundleId = value;
      else if ((value = valueAfter(args, &i, @"--url")) != nil) url = value;
      else if ((value = valueAfter(args, &i, @"--identifier")) != nil) identifier = value;
      else if ((value = valueAfter(args, &i, @"--timeout")) != nil) timeout = [value doubleValue];
      else if ([args[i] isEqualToString:@"--activate-now"]) activateNow = @"1";
    }

    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    DSHNotifyDelegate *delegate = [[DSHNotifyDelegate alloc] init];
    delegate.bundleId = bundleId;
    delegate.url = url;

    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    center.delegate = delegate;

    if ([args containsObject:@"--status"]) {
      __block NSInteger status = -1;
      [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        status = (NSInteger)settings.authorizationStatus;
        fprintf(stdout, "%ld\n", (long)status);
        fflush(stdout);
        exit(0);
      }];
      pump(5.0);
      fprintf(stdout, "--1\n");
      return 1;
    }

    if ([args containsObject:@"--request"]) {
      [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                            completionHandler:^(BOOL granted, NSError *error) {
        fprintf(stdout, granted ? "granted\n" : "denied\n");
        fflush(stdout);
        exit(granted ? 0 : 2);
      }];
      pump(60.0);
      return 1;
    }

    // A click that arrives after the posting process exited launches this app
    // with no arguments at all. Treat that as "the user wants DSH back".
    if (argc == 1) {
      delegate.bundleId = bundleId ?: kDefaultBundleId;
      [delegate activateTarget];
      return 0;
    }

    if (activateNow != nil) {
      delegate.bundleId = bundleId ?: kDefaultBundleId;
      [delegate activateTarget];
      return 0;
    }

    NSString *notifyId = [identifier length] > 0 ? identifier : [[NSUUID UUID] UUIDString];
    void (^post)(void) = ^{
      UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
      content.title = title ?: @"";
      if ([subtitle length] > 0) content.subtitle = subtitle;
      content.body = body ?: @"";
      if ([sound length] > 0) content.sound = [UNNotificationSound soundNamed:sound];
      UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:notifyId
                                                                           content:content
                                                                           trigger:nil];
      [center addNotificationRequest:request withCompletionHandler:^(NSError *error) {
        if (error != nil) {
          fprintf(stderr, "error %s\n", error.localizedDescription.UTF8String ?: "unknown");
          exit(3);
        }
        // The parent reads this line and stops waiting; the process stays alive
        // afterwards so the click can still reach this delegate.
        fprintf(stdout, "ok\n");
        fflush(stdout);
      }];
    };

    // Never ask for authorization implicitly: a banner attempt must not pop a
    // system dialog. `--request` is the only path that shows the prompt, and the
    // settings page triggers it explicitly.
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
      if (settings.authorizationStatus == UNAuthorizationStatusDenied) {
        fprintf(stderr, "denied\n");
        fflush(stderr);
        exit(2);
      }
      if (settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
        fprintf(stderr, "unauthorized\n");
        fflush(stderr);
        exit(4);
      }
      post();
    }];

    pump(timeout);
  }
  return 0;
}