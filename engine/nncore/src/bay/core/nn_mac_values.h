// Copyright 2026 Bay. Apache-2.0.
// The shared Chromium glue's states (base::DictValue) as the macOS host's dictionaries.
#ifndef BAY_CORE_NN_MAC_VALUES_H_
#define BAY_CORE_NN_MAC_VALUES_H_

#import <Foundation/Foundation.h>

#include "base/values.h"

namespace nncore {

// An empty dictionary for a state JSON can't hold.
NSDictionary* NSDictionaryFrom(const base::DictValue& value);

}  // namespace nncore

#endif  // BAY_CORE_NN_MAC_VALUES_H_
