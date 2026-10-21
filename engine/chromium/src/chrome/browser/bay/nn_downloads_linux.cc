// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/nn_downloads.h"

namespace bay {

void QuarantineDownload(const base::FilePath& file,
                        const GURL& source,
                        const GURL& referrer) {
  // Chromium has no Linux quarantine operation. Bay adds no filesystem
  // metadata here; the common completion barrier still runs on its worker.
}

}  // namespace bay
