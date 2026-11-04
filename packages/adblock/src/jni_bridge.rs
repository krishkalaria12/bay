//! JNI for the Android engine (`expo.modules.bayengine.BayAdblock`). A blocker handle is a leaked `Box<Blocker>`;
//! Kotlin frees it with `nativeFree` once no request can still reach it.

use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jlong, jstring, JNI_FALSE, JNI_TRUE};
use jni::JNIEnv;

use crate::ffi::{clean_url, set_tracking};
use crate::Blocker;

fn text(env: &mut JNIEnv, value: &JString) -> String {
    env.get_string(value).map(Into::into).unwrap_or_default()
}

fn give(env: &mut JNIEnv, value: &str) -> jstring {
    env.new_string(value)
        .map_or(std::ptr::null_mut(), |s| s.into_raw())
}

fn strings(json: &str) -> Vec<String> {
    serde_json::from_str(json).unwrap_or_default()
}

/// # Safety
/// `handle` must come from `nativeNew` and not have been freed.
unsafe fn blocker<'a>(handle: jlong) -> &'a Blocker {
    &*(handle as *const Blocker)
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bayengine_BayAdblock_nativeNew(
    mut env: JNIEnv,
    _class: JClass,
    lists: JString,
) -> jlong {
    let lists = text(&mut env, &lists);
    Box::into_raw(Box::new(Blocker::new(&lists))) as jlong
}

#[no_mangle]
pub unsafe extern "system" fn Java_expo_modules_bayengine_BayAdblock_nativeFree(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    if handle != 0 {
        drop(Box::from_raw(handle as *mut Blocker));
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_expo_modules_bayengine_BayAdblock_nativeShouldBlock(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    url: JString,
    source: JString,
    kind: JString,
) -> jboolean {
    let (url, source, kind) = (
        text(&mut env, &url),
        text(&mut env, &source),
        text(&mut env, &kind),
    );
    if blocker(handle).should_block(&url, &source, &kind, "GET") {
        JNI_TRUE
    } else {
        JNI_FALSE
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_expo_modules_bayengine_BayAdblock_nativeCosmetic(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    url: JString,
) -> jstring {
    let url = text(&mut env, &url);
    let json = serde_json::to_string(&blocker(handle).cosmetic_resources(&url)).unwrap_or_default();
    give(&mut env, &json)
}

#[no_mangle]
pub unsafe extern "system" fn Java_expo_modules_bayengine_BayAdblock_nativeHiddenSelectors(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    classes: JString,
    ids: JString,
    exceptions: JString,
) -> jstring {
    let (classes, ids, exceptions) = (
        text(&mut env, &classes),
        text(&mut env, &ids),
        text(&mut env, &exceptions),
    );
    let selectors =
        blocker(handle).hidden_selectors(&strings(&classes), &strings(&ids), &strings(&exceptions));
    give(
        &mut env,
        &serde_json::to_string(&selectors).unwrap_or_default(),
    )
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bayengine_BayAdblock_nativeSetTracking(
    mut env: JNIEnv,
    _class: JClass,
    json: JString,
) -> jboolean {
    let json = text(&mut env, &json);
    if set_tracking(&json) {
        JNI_TRUE
    } else {
        JNI_FALSE
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_bayengine_BayAdblock_nativeCleanUrl(
    mut env: JNIEnv,
    _class: JClass,
    url: JString,
) -> jstring {
    let url = text(&mut env, &url);
    clean_url(&url).map_or(std::ptr::null_mut(), |clean| give(&mut env, &clean))
}
