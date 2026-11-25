// Bay's encrypted sync format on the desktops (packages/rust/bay-sync/src/ffi.rs), linked through bay-desktop: a
// chain's keys, sealed files and the recovery phrase. Strings belong to the library: release them with
// bay_sync_string_free. Sealed files are released with bay_sync_bytes_free; opened payloads, which are secret, with
// bay_sync_secret_free, which wipes them first.

#ifndef BAY_SYNC_H_
#define BAY_SYNC_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct BaySyncKeys BaySyncKeys;

// A chain's keys from its 32 random bytes (the recovery phrase's entropy); null when `entropy` is.
BaySyncKeys *bay_sync_keys_new(const uint8_t *entropy);
// Wipes and frees the keys.
void bay_sync_keys_free(BaySyncKeys *keys);
// The chain's folder name.
char *bay_sync_chain_tag(const BaySyncKeys *keys);
// The folder name of `scope` in the chain.
char *bay_sync_scope_tag(const BaySyncKeys *keys, const char *scope);

// `payload` sealed as file `file_id` in the scope tagged `scope_tag`, with a fresh nonce; free with bay_sync_bytes_free.
uint8_t *bay_sync_seal(const BaySyncKeys *keys, const uint8_t *payload, size_t payload_length, const char *scope_tag,
                       const char *file_id, size_t *length);
// bay_sync_seal with the given 12-byte nonce, for cross-platform test vectors only; null `nonce` draws one.
uint8_t *bay_sync_seal_with_nonce(const BaySyncKeys *keys, const uint8_t *payload, size_t payload_length,
                                  const char *scope_tag, const char *file_id, const uint8_t *nonce, size_t *length);
// 0 opened (free *payload with bay_sync_secret_free), 1 not a sync file, 2 didn't open with these keys.
int32_t bay_sync_open(const BaySyncKeys *keys, const uint8_t *file, size_t length, const char *scope_tag,
                      const char *file_id, uint8_t **payload, size_t *payload_length);
void bay_sync_string_free(char *text);
void bay_sync_bytes_free(uint8_t *data, size_t length);
// Wipes and frees secret bytes the library returned.
void bay_sync_secret_free(uint8_t *data, size_t length);

// A new file's name: 16 random bytes in base32.
char *bay_sync_new_file_id(void);
// A new chain's 32 random bytes into `out`.
void bay_sync_random_entropy(uint8_t *out);
// Whether `name` is a tag (26 base32 letters), as every chain, scope and file name is.
bool bay_sync_is_tag(const char *name);

// The 24 recovery phrase words for a chain's 32 bytes, separated by single spaces.
char *bay_sync_phrase_words(const uint8_t *entropy);
// A typed phrase's 32 bytes into `out`: 0 read; 1 wrong word count (*detail the count); 2 not a word (*detail the
// word); 3 checksum failed. *detail is null or freed with bay_sync_string_free; `detail` may be null.
int32_t bay_sync_phrase_entropy(const char *text, uint8_t *out, char **detail);

#ifdef __cplusplus
}
#endif

#endif  // BAY_SYNC_H_
