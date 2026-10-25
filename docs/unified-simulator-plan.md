# 大一统模拟器 · 规划（技术栈 A）

> 目标：**浏览器一个面板**，7 个可配置层，每层「缺省 / 自定义」。浏览器只做**配置 + 相机画面 + 指令遥控**，**3D 渲染归 daedalus 原生 Bevy 窗口**。

## 一、技术栈决策（已定）

| 项 | 决策 |
|---|---|
| 前端 | **浏览器**：配置面板（7 层表单）+ 相机画面（MJPEG）+ 指令按钮。**不再做 3D 渲染** |
| 后端 | **daedalus（Rust/Bevy）单核心**：物理 + 3D 渲染（Bevy 窗口）+ 相机 JPEG 流 + 控制执行 + 协议 |
| 桥接 | **Python 薄层**：MJPEG 转发 + 指令转发 + 配置读写 + 遥测 |
| 已废弃 | **P2 的 three.js 3D 渲染**（scene.html 的 glb 渲染 + 7670 状态流 + glb 服务）——3D 归 daedalus，浏览器不再渲染实时 3D |

> 保留但不并入仿真器：原 **cad-viewer（浏览器 three.js）** 作为独立「CAD 作品展示/查看器」（离线看 glb、调材质、剖切、爆炸、FPV 等），它与仿真器是两条路。

## 二、目标架构

```
浏览器（统一面板，不渲染 3D）
 ├─ 7 层配置表单（缺省/自定义）
 ├─ 相机画面（MJPEG）
 └─ 指令按钮（GIMBAL/FIRE/RESET/GYRO/DART）

          ↕ HTTP（薄桥接 bridge.py）

daedalus（单核心）
 ├─ 读 simulator-config.json（7 层，缺省=内置默认）
 ├─ 物理 + 控制 + 协议（TCP 7666 图像 / 7667 指令）
 ├─ 相机 JPEG 流 → 桥接 MJPEG → 浏览器
 └─ Bevy 窗口 = 3D 可视化（本地看，原生渲染）
```

## 三、七层配置 + 前后端归属

| # | 层 | 缺省默认（daedalus 内置） | 前端面板（配置入口） | 后端消费（daedalus） |
|---|---|---|---|---|
| 1 | 机器人模型 | 内置整车 glb | 选择/上传 glb/URDF | 加载模型 → Bevy 渲染 |
| 2 | 材质 | PBR 预设（碳纤维/铝/塑料） | 预设/覆盖（表单） | 渲染时应用材质 |
| 3 | 关节 | 无（静态） | joints.json / URDF（表单/文件） | 物理关节 + 运动学 |
| 4 | FPV 相机 | 模型中心 72% 高度 | 锚点/位置/朝向（表单） | 相机位姿 |
| 5 | 上下位机框架 | TCP 直连 | 协议/端口（表单） | 协议栈（TCP/UDP/SHM） |
| 6 | 运动控制器 | 理想云台 + 基础底盘 | 云台/底盘/陀螺参数（表单） | 控制执行 |
| 7 | 视觉自瞄 | 手动占位 | 算法插件/参数 | 视觉算法接口 |

**归属原则**：7 层配置**全部由 daedalus 消费**（模型加载、材质、关节物理、相机、协议、控制、视觉），浏览器**只做配置编辑 + 显示 + 遥控**。缺省值写在 daedalus 内置（或一份默认 config），用户改了就覆盖。

## 四、配置契约 `simulator-config.json`

```json
{
  "robot_model": { "mode": "default", "glb": null, "urdf": null },
  "materials": { "mode": "default", "preset": "carbon-fiber", "overrides": {} },
  "joints": { "mode": "default", "source": null },
  "fpv_camera": { "mode": "default", "anchor_part": null, "origin": {"xyz":[0,0,0.72],"rpy":[0,0,0]}, "offset":[0,0,0], "yaw":0, "pitch":0 },
  "computer_framework": { "mode": "default", "protocol": "tcp", "image_port": 7666, "command_port": 7667 },
  "motion_controller": { "mode": "default", "gimbal": {"mode":"vision","max_rate":3.0}, "chassis": "mecanum" },
  "vision_algorithm": { "mode": "default", "plugin": null }
}
```

- daedalus 启动时读这份文件；缺字段用内置默认；`mode: "default"` 表示该层整体用缺省。
- 浏览器面板读写这份文件（经桥接 API），daedalus 提供「改完重启生效」或「热加载」。

## 五、路线图

- **P0 ✅ 已完成**：cad-viewer 3D 前端（材质/关节/FPV/剖切等）——现定位为**独立「静态展示/查看器」**，不入仿真器。
- **P1 ✅ 已完成**：daedalus 链路 A——浏览器控制台（相机画面 MJPEG + 指令），`start-sim.cmd` 一键启动。
- **P2 ⚠️ 已废弃**：three.js 3D 渲染 + 7670 状态流 + glb 服务——**3D 归 daedalus 原生 Bevy 窗口**，浏览器不再渲染实时 3D（scene.html 保留作调试参考，不继续投入）。
- **P3（当前）**：统一配置面板——7 层表单 + `simulator-config.json`，浏览器做配置/相机/指令，daedalus 读配置。
- **P4**：运动控制器 + 视觉自瞄做成可插拔（缺省理想/占位，可挂真实算法）。

## 六、本地资源

- 静态展示器：`projects/cad-viewer/`（viewer/*.js、tools/*.py、assets/*）
- 仿真核心：`simulator_source/daedalus-ideal-gimbal-Bata-3.2.1/`（simulator/ + guided_dart/）
- 薄桥接：`projects/cad-viewer/sim_console/bridge.py`（MJPEG + 指令 + 配置 + 遥测）
