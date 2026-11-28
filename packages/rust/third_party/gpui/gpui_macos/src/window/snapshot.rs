use crate::renderer::Renderer;
use anyhow::{Context as _, Result, bail, ensure};
use gpui::Scene;
use image::{RgbaImage, imageops};
use objc2::{
    AnyThread, DefinedClass, Message, define_class, msg_send,
    rc::{Retained, Weak, autoreleasepool},
    runtime::ProtocolObject,
};
use objc2_foundation::{NSObject, NSObjectProtocol};
use objc2_metal::{
    MTLBlitCommandEncoder, MTLBuffer, MTLCommandBuffer, MTLCommandBufferStatus, MTLCommandEncoder,
    MTLCommandQueue, MTLDevice, MTLDrawable, MTLOrigin, MTLPixelFormat, MTLResourceOptions,
    MTLSize, MTLStorageMode, MTLTexture, MTLTextureDescriptor, MTLTextureUsage,
};
use objc2_quartz_core::{CAMetalDrawable, CAMetalLayer};
use std::{
    ptr::NonNull,
    slice, thread,
    time::{Duration, Instant},
};

const GPU_DEADLINE: Duration = Duration::from_secs(2);
const GPU_POLL_INTERVAL: Duration = Duration::from_micros(200);

struct SnapshotTargetIvars {
    texture: Retained<ProtocolObject<dyn MTLTexture>>,
    layer: Retained<CAMetalLayer>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "GPUISnapshotTarget"]
    #[ivars = SnapshotTargetIvars]
    struct SnapshotTarget;

    unsafe impl NSObjectProtocol for SnapshotTarget {}

    unsafe impl MTLDrawable for SnapshotTarget {
        #[unsafe(method(present))]
        fn present(&self) {}

        #[unsafe(method(presentAtTime:))]
        fn present_at_time(&self, _presentation_time: f64) {}

        #[unsafe(method(presentAfterMinimumDuration:))]
        fn present_after_minimum_duration(&self, _duration: f64) {}

        #[unsafe(method(addPresentedHandler:))]
        fn add_presented_handler(
            &self,
            _handler: *mut block2::DynBlock<dyn Fn(NonNull<ProtocolObject<dyn MTLDrawable>>)>,
        ) {
        }

        #[unsafe(method(presentedTime))]
        fn presented_time(&self) -> f64 {
            0.
        }

        #[unsafe(method(drawableID))]
        fn drawable_id(&self) -> usize {
            0
        }
    }

    unsafe impl CAMetalDrawable for SnapshotTarget {
        #[unsafe(method(texture))]
        fn texture(&self) -> *mut ProtocolObject<dyn MTLTexture> {
            Retained::as_ptr(&self.ivars().texture).cast_mut()
        }

        #[unsafe(method(layer))]
        fn layer(&self) -> *mut CAMetalLayer {
            Retained::as_ptr(&self.ivars().layer).cast_mut()
        }
    }
);

impl SnapshotTarget {
    fn new(
        texture: Retained<ProtocolObject<dyn MTLTexture>>,
        layer: Retained<CAMetalLayer>,
    ) -> Retained<Self> {
        let this = Self::alloc().set_ivars(SnapshotTargetIvars { texture, layer });
        unsafe { msg_send![super(this), init] }
    }
}

pub(super) fn render_scene_to_image(
    renderer: &mut Renderer,
    scene: &Scene,
    scale: f32,
) -> Result<RgbaImage> {
    ensure!(
        scale.is_finite() && scale > 0. && scale <= 1.,
        "render_to_image scale must be in (0, 1], got {scale}"
    );
    let layer = renderer
        .layer()
        .context("render_to_image requires a layer-backed renderer")?
        .retain();
    let device = layer.device().context("the window's layer has no device")?;
    let drawable_size = layer.drawableSize();
    let width = drawable_size.width.ceil() as usize;
    let height = drawable_size.height.ceil() as usize;
    ensure!(
        width > 0 && height > 0,
        "render_to_image needs a window with a drawable, got {width}x{height}"
    );
    let output_width = ((width as f32 * scale).floor() as u32).max(1);
    let output_height = ((height as f32 * scale).floor() as u32).max(1);
    let mip_level = mip_level_for(scale, width.max(height));

    let (target, rendered) = autoreleasepool(|_| -> Result<_> {
        let target = new_render_target(&device, width, height, mip_level + 1)?;
        let view = target
            .newTextureViewWithPixelFormat(MTLPixelFormat::BGRA8Unorm)
            .context("creating a view of the snapshot target")?;
        let rendered = Weak::from_retained(&view);
        draw_into(renderer, scene, SnapshotTarget::new(view, layer))?;
        Ok((target, rendered))
    })?;
    wait_for_release(&rendered)?;

    let image = autoreleasepool(|_| read_back(&device, &target, mip_level))?;
    if image.dimensions() == (output_width, output_height) {
        Ok(image)
    } else {
        Ok(imageops::resize(
            &image,
            output_width,
            output_height,
            imageops::FilterType::Triangle,
        ))
    }
}

fn mip_level_for(scale: f32, longest_side: usize) -> usize {
    let wanted = (1. / scale).log2().floor().max(0.) as usize;
    wanted.min(longest_side.ilog2() as usize)
}

fn new_render_target(
    device: &ProtocolObject<dyn MTLDevice>,
    width: usize,
    height: usize,
    mip_levels: usize,
) -> Result<Retained<ProtocolObject<dyn MTLTexture>>> {
    let descriptor = MTLTextureDescriptor::new();
    unsafe {
        descriptor.setWidth(width);
        descriptor.setHeight(height);
        descriptor.setMipmapLevelCount(mip_levels);
    }
    descriptor.setPixelFormat(MTLPixelFormat::BGRA8Unorm);
    descriptor.setUsage(MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead);
    descriptor.setStorageMode(MTLStorageMode::Private);
    device
        .newTextureWithDescriptor(&descriptor)
        .context("allocating the snapshot target")
}

fn draw_into(
    renderer: &mut Renderer,
    scene: &Scene,
    target: Retained<SnapshotTarget>,
) -> Result<()> {
    let drawable = ProtocolObject::from_retained(target);
    let was_attached = renderer.is_display_link_attached();
    let presented_with_transaction = renderer.presents_with_transaction();
    if !was_attached {
        renderer.set_display_link_attached(true);
    }
    if !presented_with_transaction {
        renderer.set_presents_with_transaction(true);
    }
    let pending_frame_drawable = renderer.set_frame_drawable(Some(drawable));
    renderer.draw(scene);
    let unused = renderer.set_frame_drawable(pending_frame_drawable);
    if !presented_with_transaction {
        renderer.set_presents_with_transaction(false);
    }
    if !was_attached {
        renderer.set_display_link_attached(false);
    }
    if unused.is_some() {
        bail!("the renderer did not draw the snapshot");
    }
    Ok(())
}

fn wait_for_release(rendered: &Weak<ProtocolObject<dyn MTLTexture>>) -> Result<()> {
    let deadline = Instant::now() + GPU_DEADLINE;
    while rendered.load().is_some() {
        if Instant::now() >= deadline {
            bail!("timed out waiting for the GPU to finish the snapshot");
        }
        thread::sleep(GPU_POLL_INTERVAL);
    }
    Ok(())
}

fn read_back(
    device: &ProtocolObject<dyn MTLDevice>,
    target: &ProtocolObject<dyn MTLTexture>,
    mip_level: usize,
) -> Result<RgbaImage> {
    let width = (target.width() >> mip_level).max(1);
    let height = (target.height() >> mip_level).max(1);
    let bytes_per_row = width * 4;
    let byte_count = bytes_per_row * height;
    let buffer = device
        .newBufferWithLength_options(byte_count, MTLResourceOptions::StorageModeShared)
        .context("allocating the snapshot readback buffer")?;
    let queue = device
        .newCommandQueue()
        .context("creating the snapshot command queue")?;
    let command_buffer = queue
        .commandBuffer()
        .context("creating the snapshot command buffer")?;
    let blit = command_buffer
        .blitCommandEncoder()
        .context("creating the snapshot blit encoder")?;
    if mip_level > 0 {
        blit.generateMipmapsForTexture(target);
    }
    unsafe {
        blit.copyFromTexture_sourceSlice_sourceLevel_sourceOrigin_sourceSize_toBuffer_destinationOffset_destinationBytesPerRow_destinationBytesPerImage(
            target,
            0,
            mip_level,
            MTLOrigin { x: 0, y: 0, z: 0 },
            MTLSize {
                width,
                height,
                depth: 1,
            },
            &buffer,
            0,
            bytes_per_row,
            byte_count,
        );
    }
    blit.endEncoding();
    command_buffer.commit();
    command_buffer.waitUntilCompleted();
    ensure!(
        command_buffer.status() == MTLCommandBufferStatus::Completed,
        "reading the snapshot back failed: {:?}",
        command_buffer.error()
    );

    let mut rgba =
        unsafe { slice::from_raw_parts(buffer.contents().as_ptr().cast::<u8>(), byte_count) }
            .to_vec();
    for pixel in rgba.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    RgbaImage::from_raw(width as u32, height as u32, rgba)
        .context("creating an RGBA image from the snapshot")
}

#[cfg(test)]
mod tests {
    use super::mip_level_for;

    #[test]
    fn picks_the_smallest_mip_level_at_least_as_large_as_the_scale() {
        assert_eq!(mip_level_for(1., 1600), 0);
        assert_eq!(mip_level_for(0.75, 1600), 0);
        assert_eq!(mip_level_for(0.5, 1600), 1);
        assert_eq!(mip_level_for(0.3, 1600), 1);
        assert_eq!(mip_level_for(0.25, 1600), 2);
        assert_eq!(mip_level_for(0.001, 4), 2);
        assert_eq!(mip_level_for(0.5, 1), 0);
    }
}
