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
//              [--activate com.deepseek.dsh] [--focus-url dsh://open]
//              [--url https://...]
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
@property (nonatomic, copy) NSString *focusUrl;
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
  // The desktop app's own URL handler restores, focuses and (if needed) launches
  // the window, which is more reliable than activating a bundle that is not running.
  if ([self.focusUrl length] > 0) {
    NSURL *focus = [NSURL URLWithString:self.focusUrl];
    if (focus != nil && [[NSWorkspace sharedWorkspace] openURL:focus]) return;
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
  completionHandler();
  // The system foregrounds this helper for a banner click right after the
  // response. Wait for that switch, then put DSH in front so the user ends up
  // in DSH rather than in the invisible helper.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.35 * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
    [self activateTarget];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.45 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
      exit(0);
    });
  });
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

/// Write the delivery result where the launching process can read it.
static void writeReport(NSString *path, NSString *line) {
  if ([path length] == 0) return;
  [line writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

/// Keep the run loop alive briefly so a completion handler can fire.
static void pump(NSTimeInterval seconds) {
  static BOOL launched = NO;
  if (!launched) {
    launched = YES;
    // A click on an old banner launches this bundle; finishing the launch lets
    // UserNotifications deliver the response and keeps LaunchServices from
    // reporting a failed launch when main() returns moments later.
    [NSApp finishLaunching];
  }
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
    NSString *focusUrl = nil;
    NSString *url = nil;
    NSString *identifier = nil;
    NSString *reportPath = nil;
    NSString *activateNow = nil;
    double timeout = 120.0;

    for (NSUInteger i = 0; i < args.count; i++) {
      NSString *value;
      if ((value = valueAfter(args, &i, @"--title")) != nil) title = value;
      else if ((value = valueAfter(args, &i, @"--subtitle")) != nil) subtitle = value;
      else if ((value = valueAfter(args, &i, @"--body")) != nil) body = value;
      else if ((value = valueAfter(args, &i, @"--sound")) != nil) sound = value;
      else if ((value = valueAfter(args, &i, @"--activate")) != nil) bundleId = value;
      else if ((value = valueAfter(args, &i, @"--focus-url")) != nil) focusUrl = value;
      else if ((value = valueAfter(args, &i, @"--url")) != nil) url = value;
      else if ((value = valueAfter(args, &i, @"--identifier")) != nil) identifier = value;
      else if ((value = valueAfter(args, &i, @"--report")) != nil) reportPath = value;
      else if ((value = valueAfter(args, &i, @"--timeout")) != nil) timeout = [value doubleValue];
      else if ([args[i] isEqualToString:@"--activate-now"]) activateNow = @"1";
    }

    // An explicit action keeps the banner useful even for a click that lands on
    // the action button rather than the banner body.
    UNNotificationAction *openAction =
        [UNNotificationAction actionWithIdentifier:@"OPEN" title:@"Open DSH" options:0];
    UNNotificationCategory *category =
        [UNNotificationCategory categoryWithIdentifier:@"DSH_OPEN"
                                              actions:@[ openAction ]
                                    intentIdentifiers:@[]
                                              options:UNNotificationCategoryOptionNone];

    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    DSHNotifyDelegate *delegate = [[DSHNotifyDelegate alloc] init];
    delegate.bundleId = bundleId;
    delegate.focusUrl = focusUrl;
    delegate.url = url;

    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    center.delegate = delegate;
    [center setNotificationCategories:[NSSet setWithObject:category]];

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
      delegate.focusUrl = @"dsh://open";
      // The system launches this app to deliver the click on a banner whose
      // posting process already exited. Wait for that response; the delegate
      // activates DSH. If no response arrives (plain `open`), fall back to an
      // activation so the launch still does something useful.
      pump(2.0);
      [delegate activateTarget];
      pump(0.3);
      return 0;
    }

    if (activateNow != nil) {
      delegate.bundleId = bundleId ?: kDefaultBundleId;
      delegate.focusUrl = focusUrl ?: @"dsh://open";
      [delegate activateTarget];
      pump(0.3);
      return 0;
    }

    // The web GUI URL carries the session token. The plugin passes it through the
    // environment so the credential never appears in this process's arguments.
    if ([url length] == 0) {
      const char *fromEnvironment = getenv("DSH_NOTIFY_URL");
      if (fromEnvironment != NULL && fromEnvironment[0] != '\0') {
        url = [NSString stringWithUTF8String:fromEnvironment];
        delegate.url = url;
      }
    }

    NSString *notifyId = [identifier length] > 0 ? identifier : [[NSUUID UUID] UUIDString];
    void (^post)(void) = ^{
      UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
      content.title = title ?: @"";
      if ([subtitle length] > 0) content.subtitle = subtitle;
      content.body = body ?: @"";
      content.categoryIdentifier = @"DSH_OPEN";
      if ([sound length] > 0) content.sound = [UNNotificationSound soundNamed:sound];
      UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:notifyId
                                                                           content:content
                                                                           trigger:nil];
      [center addNotificationRequest:request withCompletionHandler:^(NSError *error) {
        if (error != nil) {
          fprintf(stderr, "error %s\n", error.localizedDescription.UTF8String ?: "unknown");
          writeReport(reportPath, [NSString stringWithFormat:@"error %@", error.localizedDescription ?: @"unknown"]);
          exit(3);
        }
        writeReport(reportPath, @"ok");
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
        writeReport(reportPath, @"denied");
        exit(2);
      }
      if (settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
        fprintf(stderr, "unauthorized\n");
        fflush(stderr);
        writeReport(reportPath, @"unauthorized");
        exit(4);
      }
      post();
    }];

    pump(timeout);
  }
  return 0;
}