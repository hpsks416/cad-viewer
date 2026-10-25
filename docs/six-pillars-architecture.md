# 六底座 ↔ 本项目架构对照

> 来源：息壤开物 LPM 的「六个能力底座」（统一Token / 统一模型架构 / 强化学习 / 数据 / 评测 / 工程）。
> 参考：[量子位《华为大模型双子星联手创业，要找物理世界的Scaling Law》](https://www.qbitai.com/2026/09/497070.html)

息壤把 LPM 拆成六个底座形成一个闭环：数据 → 统一表征 → 生成动作并预测后果 → 仿真/真实环境检验 → 奖励/评测反馈 → 再入训练。本项目是「CAD 可视化管线」而非训练模型，六底座能对上五座（缺「强化学习」）：

| 息壤底座 | 本项目对应 | 说明 |
|---|---|---|
| 统一 Token | `tools/import_step.py` + `export_step.py` | 把异构 CAD（STEP AP214 面颜色/装配层级/中文零件名、STL）归一成统一表征：`glb + parts.json + joints.json + meta.json + manifest.json` |
| 统一模型架构 | `tools/build.py` | 一条编排流水线通吃 STL/STEP，`convert-presets.json` 控制网格生成与压缩 |
| 强化学习 | ——（不适用） | 本项目不训练模型；对应物是「关节约束」这种**显式因果结构**（见 `viewer/joints.js`） |
| 数据体系 | `assets/export` + `naming-map.json` + `materials/presets.json` | 输入工程 + 中文命名翻译 + 材质库 |
| 评测体系 | `work/convert-history.json` + 缩略图预览 | 每次转换的预设/耗时/产物大小沉淀（历史），缩略图做可视化 QA |
| 工程底座 | `server.py` / `run.py` / `rust-server` + `tools/ensure_ocp.py` | 静态服务 + 批量转换 API + 自动下载 OCP 绑定 |

## 闭环对照

息壤的「数据 → 表征 → 动作 → 检验 → 反馈 → 训练」闭环，在本项目的对应物是：

```
assets/export（数据）
  → build.py（统一表征 + 编排）
  → models/*.glb（产物）
  → 浏览器 three.js（检验：渲染 + 关节 + 剖切 + 驾驶）
  → convert-history.json（反馈：耗时/大小/成败）
  → convert-presets.json（沉淀：下一轮转换的参数起点）
```

## 备注

「因果 vs 统计相关」这条在本文中最独到，本项目的对应物是 `joints.json`（revolute/prismatic/continuous + 轴/pivot）——它编码的是**机械因果结构**而非表面外观，这是本项目最接近「物理因果」的部分。
