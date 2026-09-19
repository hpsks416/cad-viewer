# RoboMaster 3D 作品展示 · SolidWorks → 浏览器

把 SolidWorks 工程导出后在浏览器里做 **PBR 实时展示**，效果优于追光几何的线框/单色渲染，并尽量还原原工程的材质颜色。面向 RoboMaster 竞赛作品展示，可直接作为开源作品集 / 简历项目。

一句话流程：

```
SolidWorks 导出 STEP AP214（装配体）
   → 本地机器翻译中文零件名 → 英文 slug
   → OCP(OpenCascade) 解析：装配层级 + 实例变换 + AP214 面颜色
   → Blender 无头装配 → GLB（PBR + 层级）
   → 浏览器 three.js 查看（PBR + ACES + IBL + 关节/剖切/材质交互）
```

## 功能特性

- 支持 `STL`（单零件）与 `STEP AP214`（多零件装配体，保留原生面颜色）
- 中文零件名 **本地离线翻译**（CTranslate2 + SentencePiece + OPUS/Argos，不依赖在线 API）
- 完整保留装配层级，并生成场景树
- **可动关节**：`revolute` / `continuous` / `prismatic`，转轴标记与拖动交互
- **剖切视图**：默认 XZ 平面，可切换 XY / YZ / 斜平面
- **材质库**：颜色 / 金属度 / 粗糙度三者解耦，法线 + 粗糙度贴图（triplanar 采样），导入本地贴图，材质结果本地持久化
- 比赛场地背景 + 低视角自动虚化
- 渲染：PBR + ACES 色调映射 + IBL 环境光

## 架构

本仓库包含两套“服务层”，共享同一套前端与 CAD 流水线：

| 层 | 说明 |
|---|---|
| 前端 | `index.html` / `main.js` / `viewer/*.js`（three.js，无构建步骤，浏览器直接加载） |
| CAD 流水线 | `tools/*.py`（OCP 解析 STEP、Blender 转 glb、本地翻译），Python 实现 |
| 服务层 A | `server.py`（Python 标准库 HTTP，即开即用） |
| 服务层 B | `rust-server/`（Rust + axum，静态文件 + JSON API，更精简高效） |

服务层只负责“静态文件 + 清单/状态/批量转换 API”。重型步骤（STEP 解析、Blender 导出、翻译）由 `tools/*.py` 完成，Rust 服务通过调用 `python tools/build.py` 编排，因此**转换仍需要 Python + Blender**；只查看已生成模型时，Rust 服务可不依赖 Python 之外的重型组件。

## 快速开始

### 前置条件

- **Python 3.10+**（首次构建 STEP 时自动下载 OpenCascade 绑定 `cadquery-ocp` + `vtk` 到 `work/_vendor/`）
- **Blender**（路径在 `tools/config.json` 配置，脚本会自动探测；Blender 5.x 需官方 `STL format (legacy)` 扩展）
- **Rust 工具链**（仅使用 `rust-server/` 时需要）

### 方式一：Python 服务（推荐，功能完整）

```bash
pip install -r requirements.txt     # ctranslate2、sentencepiece（本地翻译用）
python run.py                       # 启动服务并打开浏览器
```

命令行补充：

```bash
python run.py --build             # 先把全部工程转换完，再启动服务
python run.py --build --no-serve  # 只转换（无头，不启动服务）
python run.py --no-preview        # 不渲染缩略图（更快）
```

> 首次运行会：① 自动下载本地翻译模型（~74MB，缓存 `tools/translate_models/`）；② 首次构建 STEP 时自动下载 OpenCascade 绑定（~130MB，解压 `work/_vendor/`）。之后完全离线。

### 方式二：Rust 服务（精简、高效）

```bash
cd rust-server
cargo build --release
# 运行（默认监听 127.0.0.1:8123）
./target/release/cad-viewer-server          # Linux / macOS
# .\target\release\cad-viewer-server.exe    # Windows
```

Windows 上也可直接双击根目录的 `build-rust.cmd`：它会用 vswhere 自动定位 Visual Studio、加载 MSVC 链接器环境后再执行 `cargo build --release`。

批量转换时，Rust 服务会调用 `python tools/build.py`。若你的 `python` 不在 PATH 或需指定某个解释器：

```bash
# Windows PowerShell
$env:CAD_VIEWER_PYTHON = "C:\path\to\python.exe"
# Linux / macOS
export CAD_VIEWER_PYTHON=/usr/bin/python3
```

## 流水线

```
assets/export/*.STL                      单零件
      │  本地翻译中文名 -> 英文 slug
      ▼
Blender 无头：导入 -> 归一化 -> PBR -> glb（+ 缩略图）

assets/export/*.STEP / *.STP             装配体（AP214）
      │  OCP 解析：product 层级 + 实例变换 + AP214 面颜色
      ▼
work/step/<slug>/  （hierarchy.json + 每零件 .stl）
      │  Blender 无头：重建层级 -> 按颜色赋 PBR -> 归一化 -> glb
      ▼
models/<slug>.glb + <slug>.joints.json + <slug>.meta.json + 缩略图
      │  生成 models/manifest.json
      ▼
浏览器（three.js：PBR + ACES + IBL + 关节/剖切/材质）
```

## 可动关节（仅 STEP 装配体）

STEP 装配体的每个子装配体/零件在 glTF 里都是可变换节点，可直接当关节驱动。

1. 首次转换后 `assets/joints/<slug>.json` 自动生成模板，`candidates` 列出所有候选装配节点。
2. 在 `joints` 数组里填要动的节点：

```json
{
  "joints": [
    { "node": "sub-assembly", "type": "revolute", "axis": [0, 1, 0], "pivot": [0, 0, 0], "min": -180, "max": 180, "default": 0 },
    { "node": "wheel", "type": "continuous", "axis": [0, 0, 1] }
  ]
}
```

- `type`：`revolute`（限位旋转）/ `continuous`（连续旋转）/ `prismatic`（平移）
- `axis`：节点局部坐标系下的单位轴（glTF 为 Y 轴向上）
- `pivot`：可选，节点局部坐标系下旋转轴经过的一点 `[x,y,z]`，用于修正偏置转轴；缺省绕节点原点
- 改完重新点一次「转换选中」（或直接覆盖 `models/<slug>.joints.json`）

## 材质

右侧「材质」面板把颜色、金属度、粗糙度解耦，可自由组合；法线贴图与粗糙度贴图独立选择，并支持贴图缩放。STEP/STL 网格无 UV，查看器用 triplanar（三平面投影）采样贴图。

- 点选模型或场地零件后调节颜色 / 金属度 / 粗糙度，或套用「快捷材质」预设即生效。
- 材质结果写入服务端 `user_state.json`（跨浏览器共享），「恢复默认」/「清除本地保存」均有二次确认。
- 内置 RM 常用工业材质：碳纤维、6061 铝合金、黑色玻璃纤维、白色塑料、黑色聚氨酯等。

## 查看器交互

- 左侧「RoboMaster 作品」：模型列表 + 装配层级场景树 + 批量导出/转换入口（可最小化）
- 右侧「剖面」「可动关节」「材质」三个子窗口（均可最小化）
- 视角不限制旋转；比赛场地背景仅作渲染，不参与拾取/剖切/场景树/关节
- 低视角时场地自动渐变透明虚化，避免遮挡模型

## 目录结构

```
cad-viewer/
├── run.py / server.py           # Python 服务入口
├── build-rust.cmd               # Windows 一键编译 Rust 服务（自动定位 MSVC）
├── rust-server/                 # Rust 服务（axum，替代 server.py）
├── index.html / main.js / batch.js
├── viewer/                      # joints / scene-tree / section / materials / state / panels
├── lib/three.module.js          # 内置 three.js（离线可用）
├── tools/
│   ├── build.py                 # 编排：扫描 -> 翻译 -> 转换 -> manifest
│   ├── import_step.py           # OCP 解析 STEP AP214
│   ├── export_step.py           # Blender 装配 STEP -> glb
│   ├── export_blender.py        # Blender 单零件 STL -> glb
│   ├── translate_names.py       # 本地机器翻译
│   ├── ensure_ocp.py            # 自动下载 OpenCascade 绑定
│   └── export_sldasm.ps1        # SolidWorks 2025 后台 COM 导出 STEP AP214
├── assets/
│   ├── export/                  # 原始 STL/STEP 放这里（大文件不入库，见 .gitignore）
│   ├── joints/                  # 关节描述（模板自动生成，可手改）
│   └── materials/               # 材质库 + 贴图
├── models/                      # 生成产物（glb/manifest/joints/meta，不入库）
└── work/                        # 中间产物/缩略图/依赖（不入库）
```

## 进度 / 路线图

- **M0 最小原型** ✅ 加载 glb + PBR
- **M1 首次手动导出** ✅ 单零件 STL 带材质进浏览器
- **M2 装配体 + 材质** ✅ STEP AP214 保留层级与面颜色，presets 升级 PBR
- **M3 一键自动化** ✅ `python run.py` 串起扫描 → 翻译 → 转换 → manifest → 查看器
- **M4 查看器交互** 🔶 已完成：关节、场景树、剖切、材质库、场地背景与虚化；待做：爆炸视图、热点标注、测量
- **M5 上线** ⏳ GitHub Pages 在线演示 + 简历化 README

## 提交 GitHub 前（打包说明）

仓库已通过 `.gitignore` 排除大型 / 生成 / 本地文件，避免超过 GitHub 单文件 100MB 与仓库体积限制：

- 排除：`models/`（生成的 glb）、`work/`（中间产物与依赖）、`assets/export/*`（大型原始 CAD，保留 `test_assembly.step` 与 `电池锁紧盖.STL` 两个小样例）、`tools/translate_models/`（翻译模型）、`user_state.json`（个人状态）、`rust-server/target/`
- 保留：全部源码、材质库、关节配置、SolidWorks 导出脚本、文档

提交前建议：确认无大文件被误加入（`git add` 后 `git ls-files -s` 检查），并在 README 中补充你的模型说明与演示截图/录屏。

## 前置条件（详细）

- **Blender**：路径见 `tools/config.json`，脚本自动探测 `G:\Blender\Application\blender.exe` 等常见位置。
- **Python 3.10+**：翻译用 `ctranslate2` + `sentencepiece`；STEP 解析的 OCP/vtk wheel 首次自动下载。
- **SolidWorks**：单零件另存为 `STL`；装配体另存为 `STEP AP214`（推荐）。大装配体可走 `tools/export_sldasm.ps1` 后台 COM 导出，保留零件级颜色。

## License

[MIT](./LICENSE) © 2026 hpsks416