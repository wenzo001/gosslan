use std::io::{Cursor, Write};

use sha2::{Digest, Sha256};

const MAX_STICKER_BYTES: u64 = 8 * 1024 * 1024;
const MAX_STICKER_EDGE: u32 = 4096;
const MIN_STICKER_EDGE: u32 = 32;
const MAX_STICKER_ASPECT: f64 = 6.0;
const MAX_STICKER_PIXELS: u64 = 16 * 1024 * 1024;
const MAX_GIF_FRAMES: u32 = 120;
const MAX_GIF_TOTAL_PIXELS: u64 = 64 * 1024 * 1024;

fn sticker_error(code: &'static str, message: impl std::fmt::Display) -> String {
    crate::error_codes::coded(code, message)
}

fn read_source_bytes(app: &tauri::AppHandle, path: &str) -> Result<Vec<u8>, String> {
    if path.starts_with("content://") {
        use tauri_plugin_fs::FsExt;
        let uri = url::Url::parse(path).map_err(|e| sticker_error("STICKER_URI_INVALID", format!("无法解析所选文件：{e}")))?;
        let mut src = app
            .fs()
            .open(uri, tauri_plugin_fs::OpenOptions::new().read(true).clone())
            .map_err(|e| sticker_error("STICKER_READ_FAILED", format!("打不开所选文件：{e}")))?;
        let mut bytes = Vec::new();
        std::io::Read::by_ref(&mut src)
            .take(MAX_STICKER_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| sticker_error("STICKER_READ_FAILED", format!("读取所选文件失败：{e}")))?;
        if bytes.len() as u64 > MAX_STICKER_BYTES {
            return Err(sticker_error("STICKER_TOO_LARGE", "表情文件不能超过 8 MiB"));
        }
        Ok(bytes)
    } else {
        read_limited_file(std::path::Path::new(path))
    }
}

fn read_limited_file(path: &std::path::Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|e| sticker_error("STICKER_READ_FAILED", format!("文件不存在或不可读：{e}")))?;
    let meta = file.metadata().map_err(|e| sticker_error("STICKER_READ_FAILED", format!("读取文件信息失败：{e}")))?;
    if !meta.is_file() {
        return Err(sticker_error("STICKER_NOT_FILE", "只能导入普通图片文件"));
    }
    if meta.len() > MAX_STICKER_BYTES {
        return Err(sticker_error("STICKER_TOO_LARGE", "表情文件不能超过 8 MiB"));
    }
    let mut bytes = Vec::new();
    std::io::Read::take(file, MAX_STICKER_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| sticker_error("STICKER_READ_FAILED", format!("读取所选文件失败：{e}")))?;
    if bytes.len() as u64 > MAX_STICKER_BYTES {
        return Err(sticker_error("STICKER_TOO_LARGE", "表情文件不能超过 8 MiB"));
    }
    Ok(bytes)
}

fn detect_format(bytes: &[u8]) -> Result<(image::ImageFormat, &'static str, &'static str), String> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok((image::ImageFormat::Png, "image/png", "png"));
    }
    if bytes.starts_with(b"GIF8") {
        return Ok((image::ImageFormat::Gif, "image/gif", "gif"));
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok((image::ImageFormat::WebP, "image/webp", "webp"));
    }
    Err(sticker_error("STICKER_FORMAT_UNSUPPORTED", "仅支持 PNG、GIF 和 WebP 表情"))
}

fn validate_and_decode(bytes: &[u8]) -> Result<(image::DynamicImage, u32, u32, i64, &'static str, &'static str), String> {
    let (format, mime, ext) = detect_format(bytes)?;
    let mut limits = image::io::Limits::default();
    limits.max_image_width = Some(MAX_STICKER_EDGE);
    limits.max_image_height = Some(MAX_STICKER_EDGE);
    limits.max_alloc = Some(256 * 1024 * 1024);
    let mut reader = image::io::Reader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| sticker_error("STICKER_DECODE_FAILED", format!("无法读取图片尺寸：{e}")))?;
    if width < MIN_STICKER_EDGE || height < MIN_STICKER_EDGE || width > MAX_STICKER_EDGE || height > MAX_STICKER_EDGE {
        return Err(sticker_error("STICKER_DIMENSIONS", "表情尺寸必须在 32–4096 像素之间"));
    }
    let aspect = width.max(height) as f64 / width.min(height) as f64;
    if aspect > MAX_STICKER_ASPECT {
        return Err(sticker_error("STICKER_DIMENSIONS", "表情宽高比不能超过 6:1"));
    }
    if width as u64 * height as u64 > MAX_STICKER_PIXELS {
        return Err(sticker_error("STICKER_PIXELS", "表情像素总量不能超过 16 MP"));
    }
    let img = image::load_from_memory(bytes)
        .map_err(|e| sticker_error("STICKER_DECODE_FAILED", format!("图片解码失败：{e}")))?;
    let mut frame_count = 1i64;
    if format == image::ImageFormat::Gif {
        let decoder = image::codecs::gif::GifDecoder::new(Cursor::new(bytes))
            .map_err(|e| sticker_error("STICKER_DECODE_FAILED", format!("GIF 解码失败：{e}")))?;
        let mut frames = 0u32;
        let mut total_pixels = 0u64;
        for frame in image::AnimationDecoder::into_frames(decoder) {
            let frame = frame.map_err(|e| sticker_error("STICKER_DECODE_FAILED", format!("GIF 帧解码失败：{e}")))?;
            frames += 1;
            total_pixels = total_pixels.saturating_add(frame.buffer().width() as u64 * frame.buffer().height() as u64);
            if frames > MAX_GIF_FRAMES || total_pixels > MAX_GIF_TOTAL_PIXELS {
                return Err(sticker_error("STICKER_GIF_LIMIT", "GIF 帧数或累计像素过多"));
            }
        }
        frame_count = frames as i64;
    }
    Ok((img, width, height, frame_count, mime, ext))
}

fn atomic_write(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| sticker_error("STICKER_WRITE_FAILED", format!("创建表情目录失败：{e}")))?;
    let dest = dir.join(name);
    if dest.exists() {
        return Ok(dest);
    }
    let tmp = dir.join(format!(".sticker-tmp-{}", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = std::fs::File::create(&tmp).map_err(|e| sticker_error("STICKER_WRITE_FAILED", format!("创建临时文件失败：{e}")))?;
        file.write_all(bytes).map_err(|e| sticker_error("STICKER_WRITE_FAILED", format!("写入表情失败：{e}")))?;
        file.sync_all().map_err(|e| sticker_error("STICKER_WRITE_FAILED", format!("同步表情失败：{e}")))?;
        drop(file);
        match std::fs::rename(&tmp, &dest) {
            Ok(()) => {}
            Err(e) if dest.exists() => {
                let _ = std::fs::remove_file(&tmp);
                if e.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(sticker_error("STICKER_WRITE_FAILED", format!("保存表情失败：{e}")));
                }
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(sticker_error("STICKER_WRITE_FAILED", format!("保存表情失败：{e}")));
            }
        }
        crate::private_fs::restrict_to_owner(&dest);
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result?;
    Ok(dest)
}

fn import_bytes(
    state: &AppState,
    bytes: &[u8],
    suggested_name: Option<String>,
    source_msg_id: Option<String>,
) -> Result<db::StickerEntry, String> {
    if bytes.len() as u64 > MAX_STICKER_BYTES {
        return Err(sticker_error("STICKER_TOO_LARGE", "表情文件不能超过 8 MiB"));
    }
    let sha256 = format!("{:x}", Sha256::digest(bytes));
    {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = db::get_sticker_by_sha(&dbc, &sha256).map_err(|e| e.to_string())? {
            return Ok(existing);
        }
    }
    let (img, width, height, frame_count, mime, ext) = validate_and_decode(bytes)?;
    let thumb = img.thumbnail(128, 128);
    let mut thumb_bytes = Cursor::new(Vec::new());
    thumb
        .write_to(&mut thumb_bytes, image::ImageFormat::Png)
        .map_err(|e| sticker_error("STICKER_THUMB_FAILED", format!("生成表情缩略图失败：{e}")))?;
    let path = atomic_write(&state.stickers_dir, &format!("{sha256}.{ext}"), bytes)?;
    let thumb_path = atomic_write(&state.stickers_dir.join("thumbs"), &format!("{sha256}.png"), thumb_bytes.get_ref())?;
    let name = suggested_name
        .map(|n| crate::commands::rewrite_file_name_chars(&n))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| format!("sticker.{ext}"));
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let sort_at = db::next_sticker_sort_at(&dbc).map_err(|e| e.to_string())?;
    let entry = db::StickerEntry {
        id: sha256.clone(),
        sha256: sha256.clone(),
        path: path.to_string_lossy().to_string(),
        thumb_path: thumb_path.to_string_lossy().to_string(),
        name,
        mime: mime.to_string(),
        width: width as i64,
        height: height as i64,
        frame_count,
        size: bytes.len() as i64,
        sort_at,
        source_msg_id,
    };
    db::insert_sticker(&dbc, &entry).map_err(|e| e.to_string())?;
    db::get_sticker_by_sha(&dbc, &sha256)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| sticker_error("STICKER_DB_WRITE_FAILED", "表情已保存但无法读取"))
}

#[tauri::command(async)]
pub async fn list_custom_stickers(state: State<'_, Arc<AppState>>) -> Result<Vec<db::StickerEntry>, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::list_stickers(&dbc).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("读取表情库失败：{e}"))?
}

#[tauri::command(async)]
pub async fn import_sticker(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    path: String,
    suggested_name: Option<String>,
) -> Result<db::StickerEntry, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let bytes = read_source_bytes(&app, &path)?;
        import_bytes(&s, &bytes, suggested_name, None)
    })
    .await
    .map_err(|e| format!("导入表情失败：{e}"))?
}

#[tauri::command(async)]
pub async fn add_sticker_from_message(
    state: State<'_, Arc<AppState>>,
    msg_id: String,
) -> Result<db::StickerEntry, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let path = match crate::commands::resolve_media_path(&s, &msg_id) {
            crate::commands::MediaPath::Present(path) => path,
            crate::commands::MediaPath::Gone => return Err(sticker_error("STICKER_SOURCE_GONE", "原图片已被清理")),
            crate::commands::MediaPath::Unknown(why) => return Err(sticker_error("STICKER_SOURCE_UNAVAILABLE", why)),
        };
        let bytes = read_limited_file(&path)?;
        let name = path.file_name().and_then(|n| n.to_str()).map(|s| s.to_string());
        import_bytes(&s, &bytes, name, Some(msg_id))
    })
    .await
    .map_err(|e| format!("添加到表情失败：{e}"))?
}

#[tauri::command(async)]
pub async fn read_sticker_preview(
    state: State<'_, Arc<AppState>>,
    id: String,
    thumb: bool,
    max_bytes: u64,
) -> Result<tauri::ipc::Response, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let entry = {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            db::get_sticker(&dbc, &id).map_err(|e| e.to_string())?
        }
        .ok_or_else(|| sticker_error("STICKER_NOT_FOUND", "表情不存在"))?;
        let path = if thumb { entry.thumb_path } else { entry.path };
        let meta = std::fs::metadata(&path).map_err(|e| sticker_error("STICKER_PREVIEW_GONE", format!("表情文件不存在：{e}")))?;
        if meta.len() > max_bytes.min(15 * 1024 * 1024) {
            return Err("TOO_LARGE".to_string());
        }
        let bytes = std::fs::read(&path).map_err(|e| sticker_error("STICKER_PREVIEW_FAILED", format!("读取表情失败：{e}")))?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| format!("读取表情预览失败：{e}"))?
}

#[tauri::command(async)]
pub async fn delete_custom_sticker(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let removed = {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            db::delete_sticker(&dbc, &id).map_err(|e| e.to_string())?
        };
        if let Some(entry) = removed {
            let _ = std::fs::remove_file(&entry.path);
            let _ = std::fs::remove_file(&entry.thumb_path);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("删除表情失败：{e}"))?
}

#[tauri::command(async)]
pub async fn move_custom_sticker_to_front(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        if !db::move_sticker_to_front(&dbc, &id).map_err(|e| e.to_string())? {
            return Err(sticker_error("STICKER_NOT_FOUND", "表情不存在"));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("移动表情失败：{e}"))?
}

async fn send_sticker_path(
    state: State<'_, Arc<AppState>>,
    conv_id: String,
    source: PathBuf,
) -> Result<String, String> {
    let s = state.inner().clone();
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("png").to_string();
    let dest = s.sent_dir.join(format!("sticker-{}.{ext}", Uuid::new_v4()));
    let src = source.clone();
    let dest_for_copy = dest.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::copy(&src, &dest_for_copy).map_err(|e| sticker_error("STICKER_SEND_COPY_FAILED", format!("复制表情失败：{e}")))?;
        crate::private_fs::restrict_to_owner(&dest_for_copy);
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("复制表情失败：{e}"))??;
    let path = dest.to_string_lossy().to_string();
    let is_group = conv_id.starts_with("group:");
    let result = if is_group {
        let group_id = conv_id.strip_prefix("group:").unwrap_or(&conv_id);
        crate::commands::send_group_file_impl(state, group_id.to_string(), path, None, None, None, true).await
    } else {
        crate::commands::send_file_auto_with_sticker(state, conv_id, path, None).await
    };
    if result.is_err() {
        let keep = if is_group {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            let started = db::now_ms() - 60_000;
            let file_name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("");
            match dbc.query_row(
                "SELECT COUNT(*) FROM group_files WHERE sender_id = ?1 AND name = ?2 AND created_at >= ?3",
                rusqlite::params![s.device_id, file_name, started],
                |r| r.get::<_, i64>(0),
            ) {
                Ok(count) => count > 0,
                Err(_) => true,
            }
        } else {
            false
        };
        if !keep {
            let _ = std::fs::remove_file(&dest);
        }
    }
    result
}

#[tauri::command(async)]
pub async fn send_custom_sticker(
    state: State<'_, Arc<AppState>>,
    conv_id: String,
    sticker_id: String,
) -> Result<String, String> {
    let s = state.inner().clone();
    let source = tokio::task::spawn_blocking(move || {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_sticker(&dbc, &sticker_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| sticker_error("STICKER_NOT_FOUND", "表情不存在"))
            .map(|entry| entry.path)
    })
    .await
    .map_err(|e| format!("读取表情失败：{e}"))??;
    send_sticker_path(state, conv_id, PathBuf::from(source)).await
}

#[tauri::command(async)]
pub async fn forward_favorite_sticker(
    state: State<'_, Arc<AppState>>,
    conv_id: String,
    favorite_id: String,
) -> Result<String, String> {
    let s = state.inner().clone();
    let source = tokio::task::spawn_blocking(move || {
        let favorite = {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            db::get_favorite(&dbc, &favorite_id).map_err(|e| e.to_string())?
        }
        .ok_or_else(|| sticker_error("STICKER_NOT_FOUND", "收藏不存在"))?;
        let path = favorite.media_path.ok_or_else(|| sticker_error("STICKER_SOURCE_GONE", "收藏媒体已被清理"))?;
        let canonical = std::fs::canonicalize(&path).map_err(|e| sticker_error("STICKER_SOURCE_GONE", format!("收藏媒体不存在：{e}")))?;
        let root = std::fs::canonicalize(&s.favorites_dir).unwrap_or_else(|_| s.favorites_dir.clone());
        if !canonical.starts_with(&root) {
            return Err(sticker_error("STICKER_SOURCE_UNAVAILABLE", "收藏媒体路径越权"));
        }
        Ok::<PathBuf, String>(canonical)
    })
    .await
    .map_err(|e| format!("读取收藏表情失败：{e}"))??;
    send_sticker_path(state, conv_id, source).await
}

#[tauri::command(async)]
pub async fn forward_custom_sticker(
    state: State<'_, Arc<AppState>>,
    conv_id: String,
    msg_id: String,
) -> Result<String, String> {
    let s = state.inner().clone();
    let source = tokio::task::spawn_blocking(move || {
        match crate::commands::resolve_media_path(&s, &msg_id) {
            crate::commands::MediaPath::Present(path) => Ok(*path),
            crate::commands::MediaPath::Gone => Err(sticker_error("STICKER_SOURCE_GONE", "原表情已被清理")),
            crate::commands::MediaPath::Unknown(why) => Err(sticker_error("STICKER_SOURCE_UNAVAILABLE", why)),
        }
    })
    .await
    .map_err(|e| format!("读取原表情失败：{e}"))??;
    send_sticker_path(state, conv_id, source).await
}

#[cfg(test)]
mod sticker_command_tests {
    use super::*;

    #[test]
    fn validates_png_and_rejects_non_sticker_formats() {
        let img = image::RgbaImage::from_pixel(32, 32, image::Rgba([10, 20, 30, 255]));
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let (_, w, h, frames, mime, ext) = validate_and_decode(bytes.get_ref()).unwrap();
        assert_eq!((w, h, frames, mime, ext), (32, 32, 1, "image/png", "png"));
        assert!(validate_and_decode(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>").is_err());
    }

    #[test]
    fn bounded_file_read_rejects_oversized_sources_before_loading() {
        let file = tempfile::NamedTempFile::new().unwrap();
        file.as_file().set_len(MAX_STICKER_BYTES + 1).unwrap();
        assert!(read_limited_file(file.path()).is_err());
    }

    #[test]
    fn rejects_dimensions_above_pixel_and_edge_limits() {
        let img = image::RgbaImage::from_pixel(4097, 1, image::Rgba([0, 0, 0, 0]));
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        assert!(validate_and_decode(bytes.get_ref()).is_err());
    }
}
