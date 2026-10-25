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
- **浏览器内 STEP 直接导入**：拖入 `.step/.stp` 即可在浏览器解析（occt-import-js WASM），保留装配层级与 AP214 面颜色，**无需 Blender / OCP 服务端**
- 中文零件名 **本地离线翻译**（CTranslate2 + SentencePiece + OPUS/Argos，不依赖在线 API）
- 完整保留装配层级，并生成场景树
- **可动关节**：单自由度 `revolute` / `continuous` / `prismatic`，多自由度 `ball`（球铰）/ `universal`（万向节）/ `cylindrical`（圆柱副）；支持 `origin {xyz,rpy}`（URDF 语义）精确定义关节坐标系；转轴标记、拖动交互、多自由度滑块与约束校验
- **剖切视图**：默认 XZ 平面，可切换 XY / YZ / 斜平面
- **爆炸视图**：装配体部件沿径向 / X / Y / Z 向外展开，强度可调
- **测量**：在模型表面点两点测距（毫米读数）
- **材质库**：颜色 / 金属度 / 粗糙度三者解耦，法线 + 粗糙度贴图（triplanar 采样），导入本地贴图，材质结果本地持久化
- 比赛场地背景 + 低视角自动虚化
- **驾驶模式**：碰撞体积 + 场地边界空气墙，WASD 移动、空格跳跃
- **第一人称（FPV）**：相机可配置——选中零件设锚点、细调位置与朝向，第三人称可视化后切第一人称验证
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

## 转换模式与网格参数

批量导出面板顶部有「选择文件」按钮，用系统文件选择器一次多选 `.stl` / `.step` / `.stp` 文件；浏览器会把这些文件上传到服务端的 `assets/export/`（该目录仍是转换的输入来源，手动放入同样有效），随后自动勾选加入列表，点「转换选中」即可转换。

转换完成后：① 面板底部「转换历史」记录每次的预设 / 耗时 / 产物大小，便于对比与复用；② 查看器自动加载本次转换成功的模型，形成「改预设 → 重导出 → 看效果」的一键闭环。

> 注意：文件选择器走的是「浏览器读文件 → 回环上传」，几十 MB 以内很快；对 1GB 级别的大型装配体，浏览器要把整个文件读进内存后再上传，建议这类大文件直接手动放进 `assets/export/` 更稳妥。

面板的「转换模式」下拉框决定 STEP 装配体在 OCP → Blender 阶段如何生成网格与压缩。内置三套预设（含「快速预览」用于先低清验证层级 / 材质），也可新建自定义模式并持久化到 `assets/convert-presets.json`。

| 预设 | 角度偏差 | 半径自适应 | 尺寸自适应 | 几何去重 | 压缩 |
|---|---|---|---|---|---|
| Meshopt（无损，推荐） | 0.5 rad | ✅ | ❌ | ✅ | meshopt |
| Draco（高压缩，体积最小） | 0.5 rad | ✅ | ❌ | ✅ | draco |
| 快速预览（粗网格，快） | 1.0 rad | ❌ | ❌ | ✅ | meshopt |

参数说明：

| 参数 | 类型 | 作用 |
|---|---|---|
| 角度偏差（弧度） | 0.05–1.0 | OCP 角度偏差上限，控制小特征（小圆角/齿形）的细分密度；越小越细、三角面越多 |
| 半径自适应细分 | 开关 | 开=线性偏差 0.0004×整体尺寸，保证大半径曲面（轮子）圆度；关=0.002（更粗、文件更小） |
| 按零件尺寸自适应精修 | 开关 | 按零件包围盒分档角度偏差：<25mm→0.30，25–60mm→0.15，≥60mm→基础角度 |
| 几何去重 | 开关 | 相同网格共享一份 STL/GLB 数据，减少重复实例的体积 |
| 压缩方式 | meshopt / draco / 不压缩 | meshopt 无损；draco 有损（量化，体积最小）；不压缩兼容性最好 |

`半径自适应` 与 `尺寸自适应` 不冲突：前者调的是**线性偏差**（mm 级弦高误差），后者调的是**角度偏差**（弧度级细分上限），两者正交、可任意组合。同时开启会在「更平滑」方向叠加（小/中件更细，三角面与文件更大）；追求最小体积保持内置默认即可（半径自适应开 + 尺寸自适应关）。

新建自定义模式：在下拉框点「新建自定义」，把当前参数复制为可编辑模式，可改名/保存/删除，写入 `assets/convert-presets.json`（内置预设只读）。

命令行等价（无需界面）：

```bash
python tools/build.py --files '["test_assembly.step"]' --mode '{"compression":"draco","angular_deflection":0.5,"radius_adaptive":true,"size_adaptive":false,"dedup":true}'
```

`--mode` 也接受预设 id（如 `--mode draco`）。

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
- 右侧「剖面」「爆炸视图」「FPV 相机」「可动关节」「材质」五个子窗口（均可最小化）
- 视角不限制旋转；比赛场地背景仅作渲染，不参与拾取/剖切/场景树/关节
- 低视角时场地自动渐变透明虚化，避免遮挡模型
- 左侧「驾驶模式（WASD）」进入操作模式：`W/↑ 前进 · S/↓ 后退 · A/← 左移 · D/→ 右移 · 空格 跳跃`，机器人碰撞体积被场地空气墙约束在场地内，并沿场地表面贴合移动；退出时保存当前位置作为下次初始位置；驾驶时第三人称相机平滑跟随，鼠标左键环绕视角、滚轮缩放，移动带加减速手感，顶部提示条实时显示速度
- 左侧「第一人称（FPV）」从机器人眼位看出去：在「FPV 相机」面板点「锚点 ← 选中零件」把相机放到选中零件的几何中心，再用 X/Y/Z 细调位置、偏航/俯仰调方向（第三人称下青色球 + 黄色箭头即眼位与朝向），切到第一人称验证、不合适切回再调；`W/↑ 前进 · S/↓ 后退 · A/← 左移 · D/→ 右移 · 空格 跳跃`，鼠标左键拖动看四周

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
- **M4 查看器交互** ✅ 已完成：关节、场景树、剖切、爆炸视图、材质库、场地背景与虚化、测量；大型装配体（3000 实体总装）端到端已验证；待做：热点标注
- **M5 上线** ⏳ GitHub Pages 在线演示 + 简历化 README

## 提交 GitHub 前（打包说明）

仓库已通过 `.gitignore` 排除大型 / 生成 / 本地文件，避免超过 GitHub 单文件 100MB 与仓库体积限制：

- 排除：`models/`（生成的 glb）、`work/`（中间产物与依赖）、`assets/export/*`（大型原始 CAD，保留 `test_assembly.step` 与 `电池锁紧盖.STL` 两个小样例）、`tools/translate_models/`（翻译模型）、`user_state.json`（个人状态）、`rust-server/target/`
- 保留：全部源码、材质库、关节配置、SolidWorks 导出脚本、文档

提交前建议：确认无大文件被误加入（`git add` 后 `git ls-files -s` 检查），并在 README 中补充你的模型说明与演示截图/录屏。

## 前置条件（详细）

- **Blender**：路径见 `tools/config.json`，脚本自动探测 `G:\Blender\Application\blender.exe` 等常见位置。
- **Python 3.10+**：翻译用 `ctranslate2` + `sentencepiece`；STEP 解析的 OCP/vtk wheel 首次自动下载。
- **SolidWorks**：单零件另存为 `STL`；装配体另存为 `STEP AP214`（推荐，保留零件级颜色）。
  大装配体（数千实体）推荐用 VBA 宏 `tools/export_step_ap214_v4.swb`：在 SolidWorks 打开装配体后走 `Tools → Macro → Run` 运行，
  已实测导出 3000 实体的总装（约 50 分钟，AP214 + 颜色完整，弹窗显示进度/耗时）。后台 COM 脚本 `tools/export_sldasm.ps1` 可作批量备选。

## URDF 导入

关节可从标准 URDF 导入（SolidWorks 用 SW2URDF 插件导出，见 RoboMaster 社区「高性能 SolidWorks URDF 导出插件」），得到准确的关节 origin / 轴 / 限位：

```bash
python tools/urdf_to_joints.py robot.urdf -o models/<slug>.joints.json
```

转换规则：URDF 每个 `<joint>` 映射为一条 joints.json 记录——`node`=child link 名（需与 glb 节点名一致）、`type`=revolute/continuous/prismatic、`origin`={xyz,rpy}、`axis`=关节轴、`min/max`=limit lower/upper；`fixed` 忽略，`floating/planar` 暂不支持。多自由度运动由 URDF 的关节链（串联单自由度关节）天然表达。示例见 `docs/sample-robot.urdf`。

## 仿真器控制台（浏览器 ↔ daedalus）

把 RoboMaster 视觉仿真器（daedalus，源码在 `../../simulator_source/`）接到浏览器：浏览器只做**可视化前端**（显示相机画面 + 发控制指令），物理与渲染全在仿真器。

```bash
# 1. 先启动 daedalus 仿真器（默认 TCP 7666 图像 / 7667 指令）
# 2. 启动桥接（网页开 8124）
python sim_console/bridge.py
# 3. 浏览器打开 http://127.0.0.1:8124/
```

桥接把 daedalus 的 JPEG 图像流转成浏览器 MJPEG，并把浏览器的 `GIMBAL / FIRE / RESET / GYRO / DART` 指令转发回 `7667`。仿真器在别的机器上用 `python sim_console/bridge.py --sim-host <ip>`。

**链路校验**（daedalus 启动后跑，确认图像/指令端口通）：

```bash
python sim_console/check_link.py
```

**合并项目一键启动**（daedalus 仿真器 + 桥接 + 控制台一起起）：

```bash
start-sim.cmd                                  # 双击或命令行
powershell -NoProfile -ExecutionPolicy Bypass -File create-desktop-shortcut-sim.ps1   # 一次性建桌面快捷方式
```

> 原「3D 查看器」的一键启动 `start.cmd`（8123）保持不变；`start-sim.cmd`（8124 控制台）是新增的合并项目入口。

## 参考

- [大一统模拟器 · 规划](./docs/unified-simulator-plan.md)
- [学习笔记：Simate 的 Physical AI 研发方法论 → 本项目映射](./docs/physical-ai-simate-study.md)
- [六底座 ↔ 本项目架构对照](./docs/six-pillars-architecture.md)
- [驾驶 + 关节统一状态机](./docs/robot-state-machine.md)

## 浏览器内 STEP 导入（无 Blender）

除服务端转换外，查看器也能**在浏览器里直接解析 STEP**：拖入 `.step/.stp` 文件（或访问 `?step=<url>`）即用 occt-import-js（WASM，LGPL-2.1）解析装配层级 + AP214 面颜色，**无需安装 Blender / OCP 服务端**。

```bash
# 首次需下载 WASM 解析器（约 7.6MB，之后离线可用）
powershell -NoProfile -ExecutionPolicy Bypass -File tools/download-occt.ps1
```

下载后 `lib/occt/` 内会出现 `occt-import-js.js` 与 `.wasm`。删除该目录不影响 GLB/STL 查看。许可证见 [NOTICE.md](./NOTICE.md)。

## GitHub Pages 在线演示

仓库根目录即查看器，配置 GitHub Pages（Settings → Pages → Source 选 "GitHub Actions"）后自动部署（见 `.github/workflows/pages.yml`）。因为 STEP 可在浏览器直解，演示**无需预置 GLB**：

```
https://<user>.github.io/cad-viewer/?step=assets/export/test_assembly.step
```

需满足：① `lib/occt/`（`download-occt.ps1` 产出）已提交；② `assets/export/test_assembly.step`（26KB 小样例）已提交。

## License

本项目代码 MIT © 2026 hpsks416。`lib/occt/` 为 LGPL-2.1 第三方组件，详见 [NOTICE.md](./NOTICE.md)。