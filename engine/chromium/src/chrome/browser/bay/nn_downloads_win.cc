// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/nn_downloads.h"

namespace bay {

void QuarantineDownload(const base::FilePath& file,
                        const GURL& source,
                        const GURL& referrer) {
  // Chrome's DownloadFileImpl already sends the completed file through the
  // Windows quarantine service (IAttachmentExecute), including Mark-of-the-Web
  // and attachment scanning. Do not replace its zone identifier or bypass it.
}

}  // namespace bay
