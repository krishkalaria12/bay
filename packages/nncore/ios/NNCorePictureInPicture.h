// Chrome's video Picture in Picture window, styled and handled as packages/cef's NNPictureInPicture (Dia's): rounded
// with a rim, kept on top (a remembered choice), stashed at a screen edge with a 28 pt peek, a menu with Back to Tab,
// and our speed, subtitles and Live controls over Chrome's.
#pragma once

#import <AppKit/AppKit.h>

@class NNCoreWebView;

namespace nncore_pip {

// The page script's "pip" report for a video: the window Chrome just opened for `view`'s page (frame `frameId`).
void VideoChanged(NNCoreWebView *view, NSString *host, NSString *frameId, bool active);
// The page script's report on that video (its "pipState": speed, subtitles, Live), for our controls over Chrome's.
void StateChanged(NNCoreWebView *view, NSString *frameId, NSDictionary *state);

}
