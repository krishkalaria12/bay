//! Unsafe utility functions for working with flatbuffers and other low-level operations.

use crate::filters::flatbuffer_generated::fb;

// Minimum alignment for the beginning of the flatbuffer data.
const MIN_ALIGNMENT: usize = 8;

/// Converts a flatbuffers Vector to a slice.
/// # Safety
/// This function uses unsafe code to convert flatbuffer vector bytes to a slice.
/// It asserts the vector data is properly aligned and sized.
#[inline(always)]
pub fn fb_vector_to_slice<T>(vector: flatbuffers::Vector<'_, T>) -> &[T] {
    let bytes = vector.bytes();

    const fn static_assert_alignment<T>() {
        // We can't use T with the size more than MIN_ALIGNMENT.
        // Since the beginning of flatbuffer data is aligned to that size,
        // the alignment of the data must be a divisor of MIN_ALIGNMENT.
        assert!(MIN_ALIGNMENT.is_multiple_of(std::mem::size_of::<T>()));
    }
    const { static_assert_alignment::<T>() };

    assert!(bytes.len().is_multiple_of(std::mem::size_of::<T>()));
    assert!((bytes.as_ptr() as usize).is_multiple_of(std::mem::align_of::<T>()));
    unsafe {
        std::slice::from_raw_parts(
            bytes.as_ptr() as *const T,
            bytes.len() / std::mem::size_of::<T>(),
        )
    }
}

/// Bytes something else keeps: a mapped file, say. They must stay readable and unchanged for as long as this lives, and
/// `as_ref` must return the same bytes every time.
pub type SharedBytes = std::sync::Arc<dyn AsRef<[u8]> + Send + Sync>;

enum Storage {
    Owned(Vec<u8>),
    Shared(SharedBytes),
}

// A safe wrapper around the flatbuffer data.
// It could be constructed from raw data (includes the flatbuffer verification)
// from a builder that have just been used to construct the flatbuffer
// or from bytes something else keeps, read in place instead of copied.
// Invariants:
// 1. self.data() is a flatbuffer root safe to read without the verifier. It was checked in
//    `from_raw` or accepted by `Engine::deserialize` after
//    the same-version DAT checksum matched.
// 2. self.data() is aligned to MIN_ALIGNMENT bytes.
//    This is necessary for fb_vector_to_slice.
pub(crate) struct VerifiedFlatbufferMemory {
    // The buffer containing the flatbuffer data.
    raw_data: Storage,

    // The offset of the data in the buffer.
    // Must be aligned to MIN_ALIGNMENT bytes.
    start: usize,

    // Where the data ends in the buffer.
    end: usize,
}

impl VerifiedFlatbufferMemory {
    pub(crate) fn from_raw(data: &[u8]) -> Result<Self, flatbuffers::InvalidFlatbuffer> {
        Self::from_raw_unchecked(data).verified()
    }

    pub(crate) fn verified(self) -> Result<Self, flatbuffers::InvalidFlatbuffer> {
        // Verify that the data is a valid flatbuffer.
        #[cfg(test)]
        root_as_engine_calls::record();
        let _ = fb::root_as_engine(self.data())?;

        Ok(self)
    }

    // Creates a new VerifiedFlatbufferMemory from a builder.
    // Skip the verification, the builder must contains a valid FilterList.
    pub(crate) fn from_builder(builder: flatbuffers::FlatBufferBuilder<'_>) -> Self {
        Self::from_raw_unchecked(builder.finished_data())
    }

    // Aligns `data` and wraps it without running the FlatBuffer verifier.
    // The caller must already know `data` satisfies invariant 1.
    pub(crate) fn from_raw_unchecked(data: &[u8]) -> Self {
        let mut vec = Vec::with_capacity(data.len() + MIN_ALIGNMENT);
        let shift = vec.as_ptr() as usize % MIN_ALIGNMENT;

        let start = if shift == 0 {
            0
        } else {
            let shift = vec.as_ptr() as usize % MIN_ALIGNMENT;
            let padding = MIN_ALIGNMENT - shift;
            assert!(vec.capacity() >= padding);
            vec.splice(0..0, vec![0u8; padding]);
            padding
        };

        vec.extend_from_slice(data);
        assert!((vec.as_ptr() as usize + start).is_multiple_of(MIN_ALIGNMENT));

        let end = vec.len();
        let memory = Self {
            raw_data: Storage::Owned(vec),
            start,
            end,
        };
        assert!((memory.data().as_ptr() as usize).is_multiple_of(MIN_ALIGNMENT));
        memory
    }

    // Reads `range` of `bytes` in place, or from a copy when it isn't aligned (invariant 2).
    // `range` must be within `bytes`, and the caller must already know it satisfies invariant 1.
    pub(crate) fn from_shared_unchecked(bytes: SharedBytes, range: std::ops::Range<usize>) -> Self {
        let data = &(*bytes).as_ref()[range.clone()];
        if !(data.as_ptr() as usize).is_multiple_of(MIN_ALIGNMENT) {
            return Self::from_raw_unchecked(data);
        }
        Self {
            raw_data: Storage::Shared(bytes),
            start: range.start,
            end: range.end,
        }
    }

    pub(crate) fn root(&self) -> fb::Engine<'_> {
        unsafe { fb::root_as_engine_unchecked(self.data()) }
    }

    pub fn data(&self) -> &[u8] {
        let bytes: &[u8] = match &self.raw_data {
            Storage::Owned(bytes) => bytes,
            Storage::Shared(bytes) => (**bytes).as_ref(),
        };
        &bytes[self.start..self.end]
    }
}

#[cfg(test)]
pub(crate) mod root_as_engine_calls {
    use std::cell::Cell;

    thread_local! {
        static COUNT: Cell<usize> = const { Cell::new(0) };
    }

    pub(super) fn record() {
        COUNT.set(COUNT.get() + 1);
    }

    pub(crate) fn count() -> usize {
        COUNT.get()
    }
}
