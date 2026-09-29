// What NNCore's C++ side needs from its ObjC objects (not part of the host API).

#ifndef BAY_CORE_NNCORE_INTERNAL_H_
#define BAY_CORE_NNCORE_INTERNAL_H_

#import "bay/core/public/NNCore.h"

class Profile;

namespace content {
class WebContents;
}

namespace nncore {
class WindowHost;
}

@interface NNCoreProfile ()
+ (NNCoreProfile*)wrapperFor:(Profile*)profile;
@property(readonly) Profile* chromeProfile;
@end

@interface NNCoreTab ()
- (instancetype)initWithContents:(content::WebContents*)contents;
@property(readonly) content::WebContents* contents;
- (void)contentsDestroyed;
- (void)notify:(SEL)selector;
@end

@interface NNCoreWindow ()
@property(readonly) nncore::WindowHost* host;
@end

#endif  // BAY_CORE_NNCORE_INTERNAL_H_
