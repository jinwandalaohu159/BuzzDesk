// Icon extraction: shell/shortcut icons rendered to cached high-resolution PNG data URLs.
use super::*;

pub(super) const MAX_ICON_DATA_URL_CACHE_ENTRIES: usize = 256;

pub(super) static ICON_DATA_URL_CACHE: OnceLock<Mutex<HashMap<i32, String>>> = OnceLock::new();

pub(super) unsafe fn icon_for_pidl(pidl: *const ITEMIDLIST) -> Option<String> {
    let mut info = SHFILEINFOW::default();
    let result = SHGetFileInfoW(
        PCWSTR(pidl as *const u16),
        FILE_ATTRIBUTE_NORMAL,
        Some(&mut info),
        std::mem::size_of::<SHFILEINFOW>() as u32,
        SHGFI_PIDL | SHGFI_SYSICONINDEX | SHGFI_ICON | SHGFI_LARGEICON,
    );

    if result == 0 {
        return None;
    }

    icon_from_shell_file_info(info)
}

pub(super) fn icon_for_path(path: &Path) -> Option<String> {
    let wide = to_wide(&path.to_string_lossy());
    if is_shortcut_path(path) {
        if let Some(icon) = icon_for_shortcut(path) {
            return Some(icon);
        }

        if let Some(icon) = icon_for_wide_path(&wide, FILE_ATTRIBUTE_NORMAL) {
            return Some(icon);
        }
    }

    let attributes = if path.is_dir() {
        FILE_ATTRIBUTE_DIRECTORY
    } else {
        FILE_ATTRIBUTE_NORMAL
    };

    icon_for_wide_path(&wide, attributes)
}

pub(super) fn is_shortcut_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"))
}

pub(super) fn icon_for_shortcut(path: &Path) -> Option<String> {
    let _com = ComApartment::enter();
    unsafe { icon_for_shortcut_inner(path) }
}

pub(super) unsafe fn icon_for_shortcut_inner(path: &Path) -> Option<String> {
    let shell_link: IShellLinkW =
        CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
    let persist_file: IPersistFile = shell_link.cast().ok()?;
    let shortcut_path = to_wide(&path.to_string_lossy());
    persist_file
        .Load(PCWSTR(shortcut_path.as_ptr()), STGM_READ)
        .ok()?;

    let mut icon_path_buffer = [0u16; 520];
    let mut icon_index = 0i32;
    if shell_link
        .GetIconLocation(&mut icon_path_buffer, &mut icon_index)
        .is_ok()
    {
        let icon_path =
            resolve_shortcut_icon_path(path, &wide_buffer_to_string(&icon_path_buffer));
        if !icon_path.is_empty() {
            if let Some(icon) = icon_for_explicit_icon_location(&icon_path, icon_index) {
                return Some(icon);
            }

            if !Path::new(&icon_path).is_dir() {
                if let Some(icon) = icon_for_shell_path(&icon_path) {
                    return Some(icon);
                }
            }
        }
    }

    let mut target_path_buffer = [0u16; 520];
    let mut find_data = WIN32_FIND_DATAW::default();
    if shell_link
        .GetPath(
            &mut target_path_buffer,
            &mut find_data,
            SLGP_UNCPRIORITY.0 as u32,
        )
        .is_ok()
    {
        let target_path = wide_buffer_to_string(&target_path_buffer);
        if !target_path.is_empty() && !Path::new(&target_path).is_dir() {
            if let Some(icon) = icon_for_shell_path(&target_path) {
                return Some(icon);
            }
        }
    }

    None
}

pub(super) fn resolve_shortcut_icon_path(shortcut_path: &Path, icon_path: &str) -> String {
    let expanded = expand_environment_variables(icon_path);
    let path = PathBuf::from(&expanded);
    if path.is_absolute() {
        return expanded;
    }

    shortcut_path
        .parent()
        .map(|parent| parent.join(path).to_string_lossy().to_string())
        .unwrap_or(expanded)
}

pub(super) fn expand_environment_variables(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut expanded = String::with_capacity(value.len());
    let mut index = 0;

    while index < chars.len() {
        if chars[index] != '%' {
            expanded.push(chars[index]);
            index += 1;
            continue;
        }

        let Some(end_offset) = chars[index + 1..]
            .iter()
            .position(|character| *character == '%')
        else {
            expanded.push(chars[index]);
            index += 1;
            continue;
        };
        let end = index + 1 + end_offset;
        let key: String = chars[index + 1..end].iter().collect();

        if key.is_empty() {
            expanded.push('%');
            index += 1;
            continue;
        }

        if let Some(value) = env::var_os(&key) {
            expanded.push_str(&value.to_string_lossy());
        } else {
            expanded.extend(chars[index..=end].iter());
        }

        index = end + 1;
    }

    expanded
}

pub(super) unsafe fn icon_for_explicit_icon_location(path: &str, icon_index: i32) -> Option<String> {
    let fixed_path = fixed_wide_path(path)?;

    for size in [256, 128, 96, 64, 48, 32] {
        let mut icons = [HICON(std::ptr::null_mut())];
        let count = PrivateExtractIconsW(
            &fixed_path,
            icon_index,
            size,
            size,
            Some(&mut icons),
            None,
            0,
        );

        if count == 0 || icons[0].0.is_null() {
            continue;
        }

        if let Some(data_url) = icon_to_png_data_url(icons[0]) {
            return Some(data_url);
        }
    }

    None
}

pub(super) fn fixed_wide_path(path: &str) -> Option<[u16; 260]> {
    let wide = to_wide(path);
    if wide.len() > 260 {
        return None;
    }

    let mut fixed = [0u16; 260];
    fixed[..wide.len()].copy_from_slice(&wide);
    Some(fixed)
}

pub(super) fn icon_for_shell_path(path: &str) -> Option<String> {
    let wide = to_wide(path);
    if let Some(icon) = icon_for_shell_parse_name(&wide) {
        return Some(icon);
    }

    icon_for_wide_path(&wide, FILE_ATTRIBUTE_NORMAL)
}

pub(super) fn icon_for_shell_parse_name(wide: &[u16]) -> Option<String> {
    let _com = ComApartment::enter();
    unsafe {
        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        let result = SHParseDisplayName(
            PCWSTR(wide.as_ptr()),
            None::<&windows::Win32::System::Com::IBindCtx>,
            &mut pidl,
            0,
            None,
        );

        if result.is_ok() && !pidl.is_null() {
            let icon = icon_for_pidl(pidl);
            ILFree(Some(pidl));
            icon
        } else {
            None
        }
    }
}

pub(super) fn icon_for_wide_path(
    wide: &[u16],
    attributes: windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES,
) -> Option<String> {
    let mut info = SHFILEINFOW::default();
    let result = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            attributes,
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_SYSICONINDEX | SHGFI_ICON | SHGFI_LARGEICON,
        )
    };

    if result == 0 {
        return None;
    }

    unsafe { icon_from_shell_file_info(info) }
}

pub(super) unsafe fn icon_from_shell_file_info(info: SHFILEINFOW) -> Option<String> {
    if let Some(data_url) = cached_icon_data_url(info.iIcon) {
        if !info.hIcon.0.is_null() {
            let _ = DestroyIcon(info.hIcon);
        }
        return Some(data_url);
    }

    if let Some(data_url) = high_res_icon_from_system_index(info.iIcon) {
        if !info.hIcon.0.is_null() {
            let _ = DestroyIcon(info.hIcon);
        }
        remember_icon_data_url(info.iIcon, &data_url);
        return Some(data_url);
    }

    let data_url = if info.hIcon.0.is_null() {
        None
    } else {
        icon_to_png_data_url(info.hIcon)
    };

    if let Some(data_url) = data_url.as_ref() {
        remember_icon_data_url(info.iIcon, data_url);
    }

    data_url
}

pub(super) fn cached_icon_data_url(index: i32) -> Option<String> {
    if index < 0 {
        return None;
    }

    ICON_DATA_URL_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|cache| cache.get(&index).cloned())
}

pub(super) fn remember_icon_data_url(index: i32, data_url: &str) {
    if index < 0 {
        return;
    }

    let Ok(mut cache) = ICON_DATA_URL_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    else {
        return;
    };

    if cache.len() >= MAX_ICON_DATA_URL_CACHE_ENTRIES && !cache.contains_key(&index) {
        if let Some(first_key) = cache.keys().next().copied() {
            cache.remove(&first_key);
        }
    }

    cache.insert(index, data_url.to_string());
}

pub(super) unsafe fn high_res_icon_from_system_index(index: i32) -> Option<String> {
    for image_list_size in [SHIL_JUMBO, SHIL_EXTRALARGE] {
        let Ok(image_list) = SHGetImageList::<IImageList>(image_list_size as i32) else {
            continue;
        };
        let Ok(hicon) = image_list.GetIcon(index, ILD_TRANSPARENT.0) else {
            continue;
        };
        if !hicon.0.is_null() {
            if let Some(data_url) = icon_to_png_data_url(hicon) {
                return Some(data_url);
            }
        }
    }

    None
}

pub(super) unsafe fn icon_to_png_data_url(
    hicon: windows::Win32::UI::WindowsAndMessaging::HICON,
) -> Option<String> {
    let mut icon_info = ICONINFO::default();
    if GetIconInfo(hicon, &mut icon_info).is_err() {
        let _ = DestroyIcon(hicon);
        return None;
    }

    let hbitmap = if !icon_info.hbmColor.0.is_null() {
        icon_info.hbmColor
    } else {
        icon_info.hbmMask
    };

    if hbitmap.0.is_null() {
        cleanup_icon(hicon, icon_info);
        return None;
    }

    let mut bitmap = BITMAP::default();
    let object_result = GetObjectW(
        HGDIOBJ(hbitmap.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bitmap as *mut BITMAP as *mut c_void),
    );

    if object_result == 0 || bitmap.bmWidth <= 0 || bitmap.bmHeight <= 0 {
        cleanup_icon(hicon, icon_info);
        return None;
    }

    let width = bitmap.bmWidth;
    let height = if icon_info.hbmColor.0.is_null() {
        bitmap.bmHeight / 2
    } else {
        bitmap.bmHeight
    };

    if height <= 0 {
        cleanup_icon(hicon, icon_info);
        return None;
    }

    let hdc = GetDC(None);
    if hdc.0.is_null() {
        cleanup_icon(hicon, icon_info);
        return None;
    }

    let mut bitmap_info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: (width * height * 4) as u32,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        ..Default::default()
    };

    let mut pixels = vec![0u8; (width * height * 4) as usize];
    let copied = GetDIBits(
        hdc,
        hbitmap,
        0,
        height as u32,
        Some(pixels.as_mut_ptr() as *mut c_void),
        &mut bitmap_info,
        DIB_RGB_COLORS,
    );
    // Older icons carry no alpha channel (every alpha byte is 0) and rely on
    // the AND mask for transparency; read it instead of emitting an invisible
    // image.
    if copied != 0 && !icon_info.hbmColor.0.is_null() && pixels.chunks_exact(4).all(|pixel| pixel[3] == 0) {
        apply_mask_alpha(hdc, icon_info.hbmMask, width, height, &mut pixels);
    }
    let _ = ReleaseDC(None, hdc);

    if copied == 0 {
        cleanup_icon(hicon, icon_info);
        return None;
    }

    let png = encode_png(width, height, &pixels);
    cleanup_icon(hicon, icon_info);
    let png = png?;

    Some(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(png)
    ))
}

// Alpha from an icon's monochrome AND mask: set bits are transparent. Without a
// readable mask the icon is treated as fully opaque.
unsafe fn apply_mask_alpha(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    mask: windows::Win32::Graphics::Gdi::HBITMAP,
    width: i32,
    height: i32,
    pixels: &mut [u8],
) {
    let mut mask_pixels = vec![0u8; (width * height * 4) as usize];
    let mut mask_info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let read = !mask.0.is_null()
        && GetDIBits(
            hdc,
            mask,
            0,
            height as u32,
            Some(mask_pixels.as_mut_ptr() as *mut c_void),
            &mut mask_info,
            DIB_RGB_COLORS,
        ) != 0;

    for (index, pixel) in pixels.chunks_exact_mut(4).enumerate() {
        let transparent = read && mask_pixels[index * 4] != 0;
        pixel[3] = if transparent { 0 } else { 255 };
    }
}

pub(super) unsafe fn cleanup_icon(
    hicon: windows::Win32::UI::WindowsAndMessaging::HICON,
    icon_info: ICONINFO,
) {
    if !icon_info.hbmColor.0.is_null() {
        let _ = DeleteObject(HGDIOBJ(icon_info.hbmColor.0));
    }

    if !icon_info.hbmMask.0.is_null() {
        let _ = DeleteObject(HGDIOBJ(icon_info.hbmMask.0));
    }

    let _ = DestroyIcon(hicon);
}

pub(super) fn encode_png(width: i32, height: i32, bgra_pixels: &[u8]) -> Option<Vec<u8>> {
    let mut rgba = Vec::with_capacity(bgra_pixels.len());
    for pixel in bgra_pixels.chunks_exact(4) {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }

    let (image_width, image_height, image_pixels) =
        trim_transparent_padding(width, height, rgba)?;
    let mut bytes = Vec::new();
    {
        let mut encoder =
            png::Encoder::new(&mut bytes, image_width as u32, image_height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&image_pixels).ok()?;
    }

    Some(bytes)
}

pub(super) fn trim_transparent_padding(
    width: i32,
    height: i32,
    rgba: Vec<u8>,
) -> Option<(i32, i32, Vec<u8>)> {
    if width <= 0 || height <= 0 {
        return None;
    }

    let width_usize = width as usize;
    let height_usize = height as usize;
    let mut min_x = width_usize;
    let mut min_y = height_usize;
    let mut max_x = 0usize;
    let mut max_y = 0usize;
    let mut found = false;

    for y in 0..height_usize {
        for x in 0..width_usize {
            let alpha = rgba[(y * width_usize + x) * 4 + 3];
            if alpha <= 8 {
                continue;
            }

            found = true;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
    }

    if !found {
        return Some((width, height, rgba));
    }

    min_x = min_x.saturating_sub(1);
    min_y = min_y.saturating_sub(1);
    max_x = (max_x + 1).min(width_usize - 1);
    max_y = (max_y + 1).min(height_usize - 1);

    let trim_width = max_x - min_x + 1;
    let trim_height = max_y - min_y + 1;
    let should_trim =
        trim_width * 100 < width_usize * 92 || trim_height * 100 < height_usize * 92;
    if !should_trim {
        return Some((width, height, rgba));
    }

    let mut trimmed = Vec::with_capacity(trim_width * trim_height * 4);
    for y in min_y..=max_y {
        let start = (y * width_usize + min_x) * 4;
        let end = start + trim_width * 4;
        trimmed.extend_from_slice(&rgba[start..end]);
    }

    Some((trim_width as i32, trim_height as i32, trimmed))
}
