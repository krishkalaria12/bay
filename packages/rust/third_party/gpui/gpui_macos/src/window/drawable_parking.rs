//! Shrinks a hidden window's drawables so their memory goes back to the system.
//!
//! A `CAMetalLayer` keeps a pool of full-window drawables. Changing its
//! `drawableSize` releases the pooled drawables of the old size, while the one
//! on screen stays the layer's contents until the next frame replaces it. So a
//! hidden window parks at a tiny drawable size and keeps showing its last frame,
//! and it gets its full size back before drawing again.

use super::renderer::{self, Renderer};
use gpui::{DevicePixels, Size, size};

/// The drawable size of a window that is not visible.
pub(super) const PARKED_DRAWABLE_SIZE: Size<DevicePixels> = size(DevicePixels(1), DevicePixels(1));

const PARK_DRAWABLES_ENV: &str = "ARDIA_GPUI_PARK_DRAWABLES";

/// Remembers the full drawable size of a parked window.
#[derive(Debug)]
pub(super) struct DrawableParking {
    enabled: bool,
    full_size: Option<Size<DevicePixels>>,
}

impl Default for DrawableParking {
    fn default() -> Self {
        Self {
            enabled: true,
            full_size: None,
        }
    }
}

impl DrawableParking {
    /// Parking is on unless `ARDIA_GPUI_PARK_DRAWABLES=0`.
    pub(super) fn from_env() -> Self {
        Self {
            enabled: std::env::var(PARK_DRAWABLES_ENV).map_or(true, |value| value != "0"),
            full_size: None,
        }
    }

    pub(super) fn is_parked(&self) -> bool {
        self.full_size.is_some()
    }

    /// Parks a layer whose drawables are `current`. Returns the size to give
    /// the layer, or `None` when it is already parked or has nothing to free.
    pub(super) fn park(&mut self, current: Size<DevicePixels>) -> Option<Size<DevicePixels>> {
        if !self.enabled || self.is_parked() || area(current) <= area(PARKED_DRAWABLE_SIZE) {
            return None;
        }
        self.full_size = Some(current);
        Some(PARKED_DRAWABLE_SIZE)
    }

    /// Ends parking. Returns the size to give the layer back, if it was parked.
    pub(super) fn unpark(&mut self) -> Option<Size<DevicePixels>> {
        self.full_size.take()
    }

    /// Takes a new drawable size. Returns the size to give the layer now: a
    /// parked layer keeps its tiny size and restores to `new_size` instead.
    pub(super) fn resize(&mut self, new_size: Size<DevicePixels>) -> Option<Size<DevicePixels>> {
        match &mut self.full_size {
            Some(full_size) => {
                *full_size = new_size;
                None
            }
            None => Some(new_size),
        }
    }
}

/// Parks `renderer`'s layer and lets the shared instance buffers shrink back
/// to their starting size; the next large frame grows them again.
pub(super) fn park_layer(
    parking: &mut DrawableParking,
    renderer: &mut Renderer,
    instance_buffer_pool: &renderer::Context,
) {
    let Some(layer) = renderer.layer() else {
        return;
    };
    let current = layer.drawableSize();
    let current = size(
        DevicePixels(current.width.round() as i32),
        DevicePixels(current.height.round() as i32),
    );
    if let Some(parked_size) = parking.park(current) {
        renderer.update_drawable_size(parked_size);
        *instance_buffer_pool.lock() = renderer::InstanceBufferPool::default();
    }
}

/// Gives a parked layer its full drawable size back. Returns whether it was
/// parked.
pub(super) fn unpark_layer(parking: &mut DrawableParking, renderer: &mut Renderer) -> bool {
    match parking.unpark() {
        Some(full_size) => {
            renderer.update_drawable_size(full_size);
            true
        }
        None => false,
    }
}

fn area(size: Size<DevicePixels>) -> i64 {
    i64::from(size.width.0.max(0)) * i64::from(size.height.0.max(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device_size(width: i32, height: i32) -> Size<DevicePixels> {
        size(DevicePixels(width), DevicePixels(height))
    }

    #[test]
    fn parking_shrinks_the_drawables_and_unparking_restores_them() {
        let mut parking = DrawableParking::default();
        assert_eq!(
            parking.park(device_size(2400, 1520)),
            Some(PARKED_DRAWABLE_SIZE)
        );
        assert!(parking.is_parked());
        assert_eq!(parking.park(PARKED_DRAWABLE_SIZE), None, "already parked");
        assert_eq!(parking.unpark(), Some(device_size(2400, 1520)));
        assert!(!parking.is_parked());
        assert_eq!(parking.unpark(), None, "nothing left to restore");
    }

    #[test]
    fn disabled_parking_leaves_the_drawables_alone() {
        let mut parking = DrawableParking {
            enabled: false,
            full_size: None,
        };
        assert_eq!(parking.park(device_size(2400, 1520)), None);
        assert!(!parking.is_parked());
    }

    #[test]
    fn a_layer_without_drawables_is_not_parked() {
        let mut parking = DrawableParking::default();
        assert_eq!(parking.park(device_size(0, 0)), None);
        assert_eq!(parking.park(PARKED_DRAWABLE_SIZE), None);
        assert!(!parking.is_parked());
    }

    fn layer_size(renderer: &Renderer) -> Size<DevicePixels> {
        let size = renderer.layer().unwrap().drawableSize();
        device_size(size.width as i32, size.height as i32)
    }

    #[test]
    fn a_parked_layer_draws_at_its_full_size_once_unparked() {
        let pool = renderer::Context::default();
        let mut renderer = renderer::new_renderer(pool.clone(), false, false).unwrap();
        renderer.update_drawable_size(device_size(640, 400));
        let mut parking = DrawableParking::default();

        park_layer(&mut parking, &mut renderer, &pool);
        assert_eq!(layer_size(&renderer), PARKED_DRAWABLE_SIZE);
        park_layer(&mut parking, &mut renderer, &pool);
        assert!(parking.is_parked(), "parking twice keeps the full size");

        assert!(unpark_layer(&mut parking, &mut renderer));
        assert_eq!(layer_size(&renderer), device_size(640, 400));
        let drawable = renderer.layer().unwrap().nextDrawable().unwrap();
        let texture = objc2_quartz_core::CAMetalDrawable::texture(&*drawable);
        assert_eq!(
            (
                objc2_metal::MTLTexture::width(&*texture),
                objc2_metal::MTLTexture::height(&*texture)
            ),
            (640, 400),
            "the first frame after unparking gets a full-size drawable"
        );
        assert!(!unpark_layer(&mut parking, &mut renderer));
    }

    #[test]
    fn a_resize_while_parked_is_applied_on_unpark() {
        let mut parking = DrawableParking::default();
        parking.park(device_size(2400, 1520));
        assert_eq!(parking.resize(device_size(1800, 1200)), None);
        assert_eq!(parking.unpark(), Some(device_size(1800, 1200)));
        assert_eq!(
            parking.resize(device_size(1000, 800)),
            Some(device_size(1000, 800)),
            "an unparked layer resizes at once"
        );
    }
}
