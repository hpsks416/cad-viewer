# RoboMaster 作品 3D 展示 — 项目规划

> 目标：在浏览器里展示 RoboMaster 竞赛作品的 SolidWorks 工程，保留原生材质（PBR），支持可动关节交互，效果优于追光几何的线框/单色。开源到 GitHub 并配在线演示，作为简历作品集。

## 1. 核心技术结论

- **渲染不是难点**：three.js 的 PBR 是成熟能力，难点在「把 SolidWorks 的几何和材质导出来」。
- **SolidWorks 原生格式 .sldprt / .sldasm 是私有的**，没有成熟开源解析器，必须导出为开放格式。
- **主链路用 STEP AP214**：单文件同时携带「装配层级 + 每零件面颜色 + 实例变换」，最贴近最终需求。
- **STEP 用 OpenCascade(OCP) 解析**：通过 Python 绑定 cadquery-ocp 读 XCAF，提取 product 层级、实例变换、AP214 颜色，逐零件导 STL。Blender 5.x 本身不直接导入 STEP，故必须经此一步。
- **STL 作为单零件兜底**：单零件工程可直接「另存为 STL」走轻量路径。
- **材质载体是 glTF 2.0**：baseColor / metallic / roughness，浏览器生态最好；AP214 颜色映射到 baseColor，presets.json 按零件名正则升级金属度/粗糙度。
- **可动关节 = 场景图里的可变换节点**：STEP 子装配体导出后就是 glTF 节点，查看器读 joints.json 驱动它。

## 2. 目录结构（当前实际）

    cad-viewer/
    ├── index.html / main.js / batch.js    # 查看器 + 批量导出面板
    ├── lib/                               # three.js 及 addons（本地化）
    ├── viewer/
    │   └── joints.js                      # 可动关节滑块面板（已实现）
    ├── models/                            # 生成的 .glb
    │   ├── manifest.json                  # 模型清单
    │   └── <slug>.{glb,joints.json,meta.json}
    ├── assets/
    │   ├── export/                        # 原始 STL / STEP 放这里
    │   ├── joints/<slug>.json             # 关节描述模板（自动生成）
    │   ├── materials/presets.json         # PBR 材质预设 + 命名正则映射
    │   └── naming-map.json                # 中文→英文译名缓存（可改）
    ├── tools/
    │   ├── build.py                       # 编排：扫描→翻译→转换→manifest
    │   ├── import_step.py                 # OCP 解析 STEP AP214 → 层级+颜色+零件 STL
    │   ├── export_step.py                 # Blender 装配 STEP → glb（PBR+层级）
    │   ├── export_blender.py              # Blender 转 STL → glb
    │   ├── translate_names.py             # 本地 CTranslate2 zh→en
    │   ├── ensure_ocp.py                  # 首次自动下载 cadquery-ocp + vtk
    │   ├── install_stl_ext.py             # 启用 Blender STL 扩展
    │   └── config.json                    # Blender 路径等配置
    ├── work/                              # 中间产物（step/、previews/、_vendor/）
    ├── run.py / server.py                 # 一键入口 / 本地服务
    ├── requirements.txt
    └── README.md

## 3. 导出管线

### 3.1 单零件（STL）

    assets/export/零件.STL
      -> translate_names.py（本地 zh→en，缓存 naming-map.json）
      -> tools/export_blender.py（Blender：导入 → 归一化 → PBR → glb + 缩略图）
      -> models/<slug>.glb

### 3.2 装配体（STEP AP214，主链路）

    assets/export/装配体.STEP
      -> tools/import_step.py（OCP XCAF：product 层级 + 实例变换 + AP214 面颜色）
           work/step/<slug>/hierarchy.json + parts/*.stl
      -> tools/export_step.py（Blender：读层级 → 重建 Empty 骨架 + 变换
           -> 按 AP214 颜色建 PBR 材质 -> 归一化 -> glb + 缩略图）
      -> models/<slug>.glb + <slug>.meta.json + <slug>.joints.json
      -> tools/build.py 更新 models/manifest.json

meta.json 记录归一化 scale / max_dim / units，供查看器换算真实尺寸或平移关节单位。

## 4. 材质方案

- **AP214 面颜色**直接作为 PBR Base Color（STEP 装配体自带）。
- **assets/materials/presets.json** 按零件名正则升级金属度/粗糙度，示例：

    {
      "default": { "metalness": 0.35, "roughness": 0.42 },
      "patterns": [
        { "match": ".*frame.*|.*chassis.*", "material": { "metalness": 1.0, "roughness": 0.35 } },
        { "match": ".*shaft.*|.*bolt.*",    "material": { "metalness": 1.0, "roughness": 0.22 } },
        { "match": ".*wheel.*|.*tire.*",    "material": { "metalness": 0.0, "roughness": 0.92 } }
      ]
    }

- 每个唯一颜色生成一个材质实例，避免材质爆炸；颜色与预设叠加，保留原生外观。

## 5. 可动关节（articulation）

RoboMaster 典型关节：云台 yaw/pitch、轮子连续转、舱盖/弹舱铰链。

- **关节 = 场景图里的可变换节点**：STEP 子装配体导出后即 glTF 节点，查看器直接改其局部旋转/平移。
- 首次转换后 assets/joints/<slug>.json 自动生成模板，candidates 列出所有装配节点；在 joints 数组里填要动的节点：

    {
      "joints": [
        { "node": "sub-assembly", "type": "revolute",   "axis": [0,1,0], "pivot": [0,0,0], "min": -180, "max": 180, "default": 0 },
        { "node": "wheel",        "type": "continuous", "axis": [0,0,1] }
      ],
      "candidates": [
        { "id": "root-assembly", "name": "Root Assembly" }
      ]
    }

- type：revolute（限位旋转）/ continuous（连续旋转）/ prismatic（平移）。
- axis：节点局部坐标系下的单位轴（glTF 为 Y 轴向上），需按子装配体朝向配置，不是世界轴。
- pivot：可选，节点局部坐标系下旋转轴经过的一点 `[x,y,z]`（单位与 STEP 源一致）。子装配体原点不在真实关节轴上时用它修正旋转中心；缺省则绕节点自身原点旋转。
- viewer/joints.js 读取并生成滑块，拖动即驱动节点；换模型自动复位。

## 6. 查看器架构与状态

| 模块 | 说明 | 状态 |
|---|---|---|
| 渲染底座 | three.js + PBR + ACES + IBL(RoomEnvironment) | ✅ |
| 模型加载/取景 | GLTFLoader/STLLoader + 自动框选 | ✅ |
| 批量导出面板 | 读 /api/files，勾选批量转换 | ✅ |
| 关节控制 | 读 joints.json，滑块驱动节点 | ✅ |
| 场景树 | 部件层级、点击高亮、单独显示/隐藏 | ⏳ 未实现 |
| 剖切 | clipPlane 平面剖切 | ⏳ 未实现 |
| 爆炸视图 | 沿装配方向平移部件 | ⏳ 未实现 |
| 热点标注 | 点击部件显示文字说明 | ⏳ 未实现 |
| 测量 | 点选两点测距 | ⏳ 未实现（可选） |
| 部署 | GitHub Pages + 简历化 README | ⏳ |

## 7. 里程碑

- **M0 最小原型** ✅ 加载 glb + PBR。
- **M1 首次手动导出** ✅ 单零件 STL 带材质跑进浏览器。
- **M2 装配体 + 材质** ✅ STEP AP214 保留 product 层级与面颜色，presets 升级 PBR。
- **M3 一键自动化** ✅ python run.py 串起「扫描 → 翻译 → 转换 → manifest → 查看器」，含批量可视化界面。
- **M4 查看器交互** 🔶 关节已完成；场景树/剖切/爆炸/标注待做。
- **M5 上线** ⏳ GitHub Pages 在线演示 + 简历化 README。

## 8. 手动走一遍（装配体）

**Step 1 — SolidWorks 导出**
1. 打开装配体，文件 > 另存为，类型选 STEP AP214 (.step)。
2. 放进 assets/export/。

**Step 2 — 转换**

    cd cad-viewer
    python tools/build.py

生成 models/<slug>.glb、<slug>.meta.json、<slug>.joints.json 与缩略图。

**Step 3 — 配关节**
1. 打开 assets/joints/<slug>.json，从 candidates 选要动的节点填进 joints。
2. 轴为节点局部系，按装配朝向填 axis。
3. 重新 python tools/build.py（或直接改 models/<slug>.joints.json）。

**Step 4 — 浏览器验证**

    python run.py

右侧出现「可动关节」面板，拖动滑块观察动件。

## 9. 自动化（已落地）

- python run.py --build：扫描 assets/export/ 全部 STL/STEP → 本地翻译 → 转换 → manifest → 启动服务。
- 浏览器点「批量导出 / 转换」：/api/files 列工程 → 勾选 → /api/build 批量转换 → 刷新清单。
- 依赖首次自动下载：本地翻译模型（~74MB）、OpenCascade 绑定 cadquery-ocp + vtk（~130MB，解压 work/_vendor/）。之后完全离线。

## 10. 风险与边界

- **STEP 颜色丢失**：AP214 之外的部分格式可能不带面颜色，此时 fallback 到 presets.json 默认色。
- **大装配体性能**：后续加 Draco 压缩 + 实例化 + three-mesh-bvh。
- **关节轴朝向**：axis 是节点局部系，真实关节要按子装配体朝向微调。
- **SolidWorks 版本差异**：导出选项叫法不同，以「能导出 STEP AP214 或 STL」为准。

