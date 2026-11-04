// Response-cookie filtering at the network service's trusted header hook.
#ifndef BAY_CORE_NN_COOKIE_FILTER_H_
#define BAY_CORE_NN_COOKIE_FILTER_H_

#include "base/functional/callback.h"
#include "base/memory/scoped_refptr.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "services/network/public/mojom/network_context.mojom-forward.h"

namespace base {
class SequencedTaskRunner;
}
class GURL;

namespace nncore {

using ResponseCookiePolicy = base::RepeatingCallback<bool(const GURL&)>;

// Called after Chrome installs its extension/enterprise header client. The
// policy and all proxy callbacks run on task_runner. Intercepted loads must use
// kURLLoadOptionUseHeaderClient so Set-Cookie is removed before cookie storage.
void WrapResponseCookieFilter(
    mojo::PendingRemote<network::mojom::TrustedURLLoaderHeaderClient>*
        header_client,
    ResponseCookiePolicy policy,
    scoped_refptr<base::SequencedTaskRunner> task_runner);

}  // namespace nncore

#endif  // BAY_CORE_NN_COOKIE_FILTER_H_
