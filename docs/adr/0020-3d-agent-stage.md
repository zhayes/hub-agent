# ADR 0020：Agent Office —— 3D-only 的 Agent 舞台

- **状态：** 已接受（Accepted）；A1–A6 首轮实现随本 ADR 落地（2026-11-25）
- **日期：** 2026-11-25
- **相关：** `docs/PLAN-AGENT-OFFICE.md`、`docs/PRD.md` §6.3 / §9.2 / §14.4 / §14.5、`docs/ARCHITECTURE.md` §8、`docs/UI-SPEC.md` §11、ADR 0003 / 0004 / 0019
- **视觉基线：** `preview/agent-office-3d.html`、`preview/screenshots/agent-office-*.png`

---

## 1. 背景

`/agents` 原本是状态表格，只能回答"注册了哪些 Agent"，无法表达"此刻谁在干什么、谁在等谁"。产品希望把它改成"接单办公室"：派发 → 进场 → 工位 → 等待/审批 → 盖章 → 归档 → 离场。

我们评估了两条路：

1. 继续用表格/看板增强（低成本、无 WebGL 依赖，但表达力封顶）。
2. 3D Dispatch Floor（表达力强，但引入 three、WebGL2 硬门槛、性能与可访问性负担）。

结论：采用 3D，但把它当作 **Runtime 状态的视图**，不是游戏；为此需要把"3D 是唯一形式、没有 2D 降级"、"数据只来自服务端事实"写成不可违反的门禁。

## 2. 决策

### 2.1 3D-only，无运行时 2D 降级

- `/agents` 只渲染 3D 舞台；移除旧表格，不提供 `/lite`、2D 名单/看板、自动降级。
- WebGL2 预检失败 / 初始化失败 / context lost → 显示**阻断式 unsupported 卡**，隐藏 canvas 与 HUD，不显示 2D 名单。
- 非 3D 的操作路径是 **CLI**（`hubagent agents` / `hubagent agent add`），不是 2D UI。

### 2.2 Three.js 进入 UI 依赖白名单（受控）

- 新增 `three@0.169.0` + `@types/three@0.169.0`，**精确锁版本，不接受 floating range**；升级需单独 PR + 截图/性能回归。
- **只有** `packages/web/src/features/agents/office/scene/**` 可以 `import 'three'`；HUD、路由、`shared/**` 不得 import（由 `packages/web/test/office-boundary.test.ts` 强制）。
- `AgentsRoute` 初始 chunk 不含 three：`stage-entry` 在 WebGL2 预检通过后才 `import('./scene/scene')`；失败时**不发起** three chunk 请求。
- 场景（`scene/**`）不得 import `shared/api`、`components/ui`、`routes`：场景只"指"不"决"，审批/写操作永远走 Runtime。

### 2.3 正交相机 + 程序化资产

- 固定等距正交相机 + 4 个预设（全景/工位/入口/DONE 墙）+ 点击聚焦；不做 WASD / 自由 orbit。
- 资产全部程序化：几何体 + canvas 纹理（nameplate / task / plan / DONE / 印章），不引入图片或模型文件。
- 布局数据化：8 工位 + 6 等候位 + 相机预设来自 `office/layout.ts`，不写死在渲染循环。

### 2.4 硬门槛与预算

- WebGL2：预检失败 / context lost / 初始化失败 → 阻断卡。
- 目标机器（M1 / 1440p）：8 桌 + 6 bench ≥ 60fps；无 >50ms 长任务。
- DPR 上限 2；页面隐藏时暂停渲染。
- 实测（首轮，`pnpm build:web`）：3D 场景 chunk `scene-*.js` ≈ **520 kB（gzip ≈ 132 kB）**，仅在通过预检后加载；其余 HUD 在主 chunk。
- 明/暗主题、reduced motion、移动端（WebGL2 支持则 3D，否则阻断）。

### 2.5 数据诚实

- 场景每个可见任务/状态/计时/证据都能追到 `GET /api/v1/agents/presence`、任务查询或事件。
- 未知状态显示"未知"、无数据不猜；**不随机走动、不造假进度、不假终端**。
- `entering` / `done` 是前端表现阶段（由 presence diff 推导），不是数据库状态。
- 审批只调用现有端点（`POST /api/v1/approvals/:id/approve|reject`）；姿态/动画/前端状态不回写 DB。
- 本轮无 pause/cancel HTTP 端点，因此不放对应按钮。

## 3. 后果

**正面**

- 表达力覆盖"在线/忙碌、等待授权/输入、暂停、降级、故障、完成、离线"的完整动作链。
- 读模型 `agent-presence` 只读、可单测、不写 `agents.status`，UI 与 Runtime 不漂移。
- 语义边界清晰：3D 是视图，Brain 仍是唯一决策层，审批仍走 Runtime。

**代价 / 风险**

- WebGL2 硬门槛排除部分设备：用阻断卡 + CLI 明确告知，不伪装可用。
- 3D 视觉回归 flaky：冻结相机/时钟/种子，supported/unsupported 两套断言。
- 需长期维护 three 版本与 chunk 预算。

## 4. 被否掉的选项

| 选项 | 否决理由 |
|---|---|
| 保留 2D 表格作为 fallback | 与"3D-only"冲突；会滋生两套语义与两套测试 |
| `/lite` 手机 2D 视图 | 本里程碑明确不做；移动端 WebGL2 支持则 3D，否则阻断 |
| 引入 React 3D 组件库 / 整套组件库 | 违反 ADR 0003 / 0004 / 0019；不引入第二套设计系统 |
| 自由 orbit / WASD 第一人称 | 超出"状态视图"定位，增加晕动与可访问性负担 |
| 直接把 `preview/agent-office-3d.html` 搬进生产 | preview 是单文件 spike，含 mock 演示循环；生产必须拆模块、走门禁、接真实 presence |
| 语音 / 多人共享终端 / 幻想地图 | 非目标；与"HUB 唯一决策"或产品定位冲突 |

## 5. 验收（摘要）

详见 `docs/PLAN-AGENT-OFFICE.md` §6。关键门禁：

- WebGL2 环境：8 桌 + 6 bench，无表格/无 2D；不支持：阻断卡 + 无 three chunk + CLI 提示。
- 每个可见状态可追到 presence；未知不冒充。
- 等待/故障有 beacon + banner，`N` 跳转，审批端到端。
- reduced motion 静态不丢信息；8+6 60fps；页面隐藏暂停。
- HUD/抽屉键盘可达；canvas `aria-hidden`；axe 0 critical/serious。
- 旧 Agents 表格删除；无运行时 2D 回退。
