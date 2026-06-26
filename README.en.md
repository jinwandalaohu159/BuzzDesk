# BuzzDesk

<p align="center">
  <img src="./icons/像素-蜜蜂-01.png" alt="BuzzDesk icon" width="96" />
</p>

[中文](./README.md)

BuzzDesk is a Windows desktop icon layer replacement. It keeps your existing wallpaper, hides the native Windows desktop icons, and renders a custom desktop icon system focused on organization, dragging, and virtual folders.

It is not a regular app launcher. BuzzDesk reads real Windows desktop items, displays their real icons, and provides a glass-style desktop experience with virtual folders, free/auto layout, drag-based organization, and configurable context menus.

## Features

- Replaces the visible Windows desktop icon layer while keeping the original wallpaper.
- Scans real desktop items, including apps, shortcuts, files, folders, and system icons.
- Uses real system icons with caching and warmup to reduce drag-time stutter.
- Supports auto layout and free layout.
- Supports Ctrl multi-select, drag sorting, snapping, and grouped dragging.
- Provides mobile-desktop-style virtual folders with drag in/out, expand, rename, and auto dissolve behavior.
- Supports dragging items into the Recycle Bin to delete them.
- Supports desktop context menus and selected native Windows menu items.
- Includes settings for system icons, icon size, spacing, padding, and process priority.

## Tech Stack

- Tauri 2
- Rust
- TypeScript
- Vite
- Windows API / Shell API

The frontend handles desktop UI, layout, dragging, animation, and settings. The Rust/Tauri side handles desktop scanning, native icon extraction, Shell menus, file operations, tray menu behavior, window attachment, and native desktop icon visibility.

## Download

Windows installers are available from GitHub Releases:

https://github.com/jinwandalaohu159/BuzzDesk/releases

## Development

```powershell
npm install
npm run tauri:dev
```

Build the installer:

```powershell
npm run tauri:build
```

## Status

BuzzDesk currently targets Windows desktop environments. The project is still evolving, with ongoing work focused on desktop organization, drag feel, virtual folders, visual quality, and stability.
