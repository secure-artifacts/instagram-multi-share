# IG通话共享助手

IG通话共享助手是一个独立的 Chrome/Edge 浏览器扩展，用于辅助管理多个 Instagram 网页通话窗口的屏幕共享。

## 功能

- 自动检测正在进行的 Instagram 网页通话标签页。
- 将屏幕共享启动到已选择的多个 IG 通话窗口。
- 通过悬浮按钮一键开启或停止通话窗口共享。
- 支持诊断日志和日志导出，方便排查未响应或黑屏问题。

## 本地安装

1. 打开 Chrome 或 Edge 扩展页面。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目目录：`D:\新建文件夹\instagram-multi-share`。

## 当前说明

这是 IG 专用版本，不会扫描 Messenger / Facebook 通话窗口。当前版本优先适配屏幕共享流程；摄像头批量控制保留为实验功能，后续可根据 Instagram 实际按钮表现继续细化。

## 如何发布新版本

本项目使用 GitHub Actions 自动构建和发布。每次发布新版本只需要创建一个 Git Tag 并推送即可。

### 发布步骤

#### 1. 确保代码已提交并推送

在发布之前，确保你的所有代码改动已经提交并推送到 GitHub：

```bash
# 查看当前状态
git status

# 添加所有改动
git add .

# 提交改动（把“你的改动说明”替换成实际的描述）
git commit -m "你的改动说明"

# 推送到 GitHub
git push origin main
```

#### 2. 创建版本 Tag

Git Tag 是一个版本标记，用于标识发布的版本号。版本号格式为 `v主版本.次版本.修订版本`，例如 `v1.0.0`、`v1.1.0`、`v2.0.0`。

```bash
# 创建一个新的版本 tag（将 v1.0.3 替换为你想要的版本号）
git tag -a v1.0.3 -m "Release version 1.0.3"
```

#### 3. 推送 Tag 触发自动构建

```bash
# 推送 tag 到 GitHub（这会自动触发 CI 构建）
git push origin v1.0.3
```

推送后，GitHub Actions 会自动执行以下操作：

1. 构建项目
2. 生成安全签名（Attestation）
3. 创建 Release 并上传构建产物

#### 4. 查看构建结果

- 构建进度：访问项目的 **Actions** 页面查看
- 发布结果：访问项目的 **Releases** 页面查看已发布的文件

### 版本号说明

| 版本号格式 | 什么时候用 | 示例 |
|-----------|-----------|------|
| `vX.0.0` | 重大更新、不兼容改动 | `v2.0.0` |
| `vX.Y.0` | 新增功能 | `v1.1.0` |
| `vX.Y.Z` | 修复 bug | `v1.0.1` |

### 如果构建失败怎么办

1. 访问项目的 **Actions** 页面查看错误日志。
2. 修复代码问题。
3. 删除失败的 tag 并重新创建：

```bash
# 删除本地 tag
git tag -d v1.0.3

# 删除远程 tag
git push origin :refs/tags/v1.0.3

# 修复问题后，重新创建并推送
git tag -a v1.0.3 -m "Release version 1.0.3"
git push origin v1.0.3
```

## English

IG Call Share Assistant is a standalone Chrome/Edge extension for helping manage screen sharing across multiple Instagram web call windows.

### Features

- Detects active Instagram web call tabs.
- Starts screen sharing across selected IG call windows.
- Provides a floating button for quick start/stop sharing.
- Includes diagnostics and log export for troubleshooting.

### Local Install

1. Open the Chrome or Edge extensions page.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select this folder: `D:\新建文件夹\instagram-multi-share`.

### Notes

This is a separate IG-only build. It does not scan Messenger/Facebook call windows. The current version focuses on screen sharing; batch camera control is kept as an experimental feature.
