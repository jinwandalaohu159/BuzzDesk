# BuzzDesk

[English](./README.en.md)

BuzzDesk 是一个 Windows 桌面图标层替代工具。它会在保留原有壁纸的基础上隐藏 Windows 原生桌面图标，并渲染一套更适合整理、拖拽和收纳的自定义桌面图标系统。

这个项目不是普通启动器，而是一个更偏桌面整理体验的工具：真实读取 Windows 桌面项目，显示真实图标，并提供玻璃质感 UI、虚拟文件夹、自由/自动排列、拖拽收纳和右键菜单配置。

## 主要功能

- 接管 Windows 桌面图标层，保留原桌面壁纸。
- 扫描真实桌面项目，包括应用、快捷方式、文件、文件夹和系统图标。
- 使用系统真实图标，并做图标缓存和预热，减少拖拽时的卡顿。
- 支持自动排列和自由布局。
- 支持 Ctrl 多选、拖拽排序、吸附和多选拖动。
- 支持手机桌面风格的虚拟文件夹，可拖入、拖出、展开、重命名和自动解散。
- 支持将图标拖入回收站删除。
- 支持桌面右键菜单和部分原生 Windows 菜单项。
- 支持系统图标显示配置、图标大小/间距/边距配置和进程优先级配置。

## 技术栈

- Tauri 2
- Rust
- TypeScript
- Vite
- Windows API / Shell API

前端负责桌面 UI、布局、拖拽、动画和设置界面；Rust/Tauri 侧负责桌面扫描、原生图标读取、Shell 菜单、文件操作、托盘菜单、窗口挂载和 Windows 桌面图标显示控制。

## 下载

可以在 GitHub Releases 下载 Windows 安装包：

https://github.com/jinwandalaohu159/BuzzDesk/releases

## 开发

```powershell
npm install
npm run tauri:dev
```

构建安装包：

```powershell
npm run tauri:build
```

## 当前状态

BuzzDesk 目前主要面向 Windows 桌面环境。项目仍在快速迭代中，重点会继续放在桌面整理体验、拖拽手感、虚拟文件夹、美观度和稳定性上。

