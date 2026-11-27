// Copyright 2026 Bay. Apache-2.0.
#include "bay/core/nn_mac_values.h"

#include <optional>
#include <string>

#include "base/json/json_writer.h"

namespace nncore {

NSDictionary* NSDictionaryFrom(const base::DictValue& value) {
  std::optional<std::string> json = base::WriteJson(value);
  NSData* data = json ? [NSData dataWithBytes:json->data() length:json->size()] : nil;
  id object = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  return [object isKindOfClass:NSDictionary.class] ? object : @{};
}

}  // namespace nncore
