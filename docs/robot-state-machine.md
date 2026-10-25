# 驾驶 + 关节统一状态机（状态 → 动作 → 下一状态）

> 来源：息壤开物「组合爆炸 → 回到状态/动作/下一状态」第一性原理（自回归 + 马尔可夫/贝尔曼递归）。
> 参考：[量子位《华为大模型双子星联手创业，要找物理世界的Scaling Law》](https://www.qbitai.com/2026/09/497070.html)

## 现状：查看器已经是一个（隐式）状态机

驾驶/FPV 循环和关节系统各自已是「状态 → 动作 → 下一状态」结构。

### 底盘状态机（`main.js`：`updateMovement` / `updateFpv`）

| 项 | 内容 |
|---|---|
| 状态 S | 底盘位置 `model.position`、水平速度 `driveVel`、竖直速度 `driveVy`、是否落地 `driveGrounded` |
| 动作 A | `driveKeys`（W/↑ 前进、S/↓ 后退、A/← 左移、D/→ 右移、空格 跳跃）+ 相机朝向（决定前进方向） |
| 转移 T | `updateMovement(dt)`：目标速度 → 加减速插值 → 积分位移 → 重力/跳跃 → 场地空气墙夹取 + 地面贴合 |

### 关节状态机（`viewer/joints.js`：`applyJoint` / `applyJointMulti`）

| 项 | 内容 |
|---|---|
| 状态 S | 关节节点的 `position / quaternion / scale` |
| 动作 A | 关节值（滑块 / 拖动） |
| 转移 T | `applyJoint`（单自由度）+ `applyJointMulti`（多自由度）——绕 pivot 旋转 / 沿轴平移 |

## 统一形态（未来重构方向）

把两者合并成一个 `RobotState`，一次 `step` 推进：

```js
const state = {
  base: { position: Vector3, velocity: Vector3, vy: number, grounded: bool },
  joints: Map<serial, number[]>          // 每关节的值向量
};
const action = { move: { ix, iz, jump }, jointValues: Map<serial, number[]> };
const next = step(state, action, dt);    // 纯函数：底盘积分 + 关节施加
```

`step` 内部就是「底盘 `updateMovement` + 各关节 `applyJointMulti`」的合并，把「状态 → 动作 → 下一状态」显式化，便于：

- 把关节驱动与底盘运动耦合（如舵轮转向同时改关节 + 底盘航向）
- 录制 / 回放：记录 `(state, action)` 序列即可复现运动
- 复用同一 `step` 给第三人称驾驶、FPV、乃至自动演示

## 当前落地

本项以「文档化 + 显式命名」交付，未做大重构（避免破坏已验证的驾驶手感）：

- `updateMovement` 已是底盘状态机；`applyJoint` / `applyJointMulti` 已是关节状态机。
- 两者共享「状态 → 动作 → 下一状态」结构；统一 `RobotState` 为可选后续重构。
