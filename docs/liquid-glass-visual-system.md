# AI 狼人杀全局液态玻璃系统

更新日期：2026-08-31  
实现状态：主项目 V4 视觉系统  
详细设计：`docs/superpowers/specs/2026-08-31-global-liquid-glass-system-design.md`

## 1. 系统边界

本系统只负责材质、背景、折射、色散和交互动效，不改变页面布局、游戏功能、房间状态、Socket 协议、服务端配置或组件键盘语义。

独立测试样板只作为视觉和算法参照。主项目没有复制其页面 DOM、全局脚本或布局；实际实现使用项目内的 React 生命周期、语义 UI 原语和可释放的光学运行时。

硬规则：

- 一个语义表面最多一个真实后景 lens；
- 文字、图标、输入光标和焦点环永远不进入普通 `filter:url()`；
- 上层界面可以采样先绘制的下层内容，下层不能反向采样顶栏或弹窗；
- pointermove 不创建 Canvas、位移图、Blob 或 SVG graph；
- 离屏、删除、原版模式和运行时销毁都必须释放 lease、observer 和 object URL；
- 新视觉规则必须替换旧权威，禁止通过新增 `!important` 覆盖层解决问题。

## 2. 总体架构

```text
本地视觉偏好
  ↓
visualEffectsRuntime（背景、取色、偏好同步）
  ↓
GlassRuntime
  ├─ SurfaceRegistry      发现/注册/删除/可见性/尺寸
  ├─ QualityController    RGB → 单通道 → blur → solid 预算
  ├─ FilterPool           SDF 位移图、共享 graph、LRU/lease
  └─ MotionEngine         无/标准/完整动效、共享 RAF
  ↓
空 lens + rim + 锐利语义内容
```

系统样式只有一个入口 `src/styles/liquid-glass.css`，再按职责导入：

- `glass/tokens.css`：四种材质、染色和彩边令牌；
- `glass/background.css`：昼夜背景和全局绘制顺序；
- `glass/surfaces.css`：单 lens、内容层、字段和语义色；
- `glass/states.css`：按钮动效、完整压力反馈和联排滑块；
- `glass/fallbacks.css`：无 backdrop、减少透明度、移动端降级；
- `glass/utilities.css`：设置页上传、取色和范围控件的非布局辅助样式。

当前样式系统不使用 `!important`，不再包含旧的 `ww-liquid-rim`、逐元素 `ww-adaptive-refraction` 或多轮“恢复层”。

## 3. 材质模式

| 模式 | 中心模糊 | 基础填充 | 光学表现 |
|---|---:|---|---|
| 原版 `original` | 无 | 原项目纯色 | 不启动 GlassRuntime，零额外光学资源 |
| 毛玻璃 `frosted` | 面板约 14px、控件约 8px | 中等透明 | 柔和 blur、饱和、预算内边缘折射 |
| 低透玻璃 `low-transparency` | 面板约 1.25px、控件约 .35px | 很低 | 背景清楚、轻微体积和折射 |
| 透明玻璃 `transparent` | **0px** | 无染色时完全透明 | 清晰中心、圆角边缘折射、极窄淡彩色散 |

透明模式的中心不会以 RGB 轻微错位伪造玻璃，因此不会重新变成磨砂。玻璃体积来自真实边缘位移、极弱定向高光和阴影。

无染色状态不添加默认蓝、黑或灰色底。彩边仍保留，因为它是折射色差，不是用户染色。

## 4. 彩边规范

- 方向：约 135°；
- 色相：冷青 → 蓝紫 → 极弱暖金；
- 控件宽度：约 1–1.25px；
- 面板宽度：约 1.5–1.75px；
- 静态透明度：0.10–0.14；
- 交互透明度：最高约 0.24；
- 柔化：约 0.4–0.6px；
- 色带只在最外侧，向中心完全消失。

联排 option 不拥有彩边。底座和移动 slider 各自是唯一光学所有者，且拖拽时底座的后景滤镜关闭，只让 slider 折射。

## 5. 表面角色

共享组件使用显式 `data-glass-role`，遗留页面节点由一个集中兼容映射补齐。

| 角色 | 元素 | 策略 |
|---|---|---|
| `navigation` | 顶栏、房间栏、手机底栏 | 后绘制，可采样正文，折射向内渐隐 |
| `panel` | 卡片、阶段、聊天/事件栏、设置卡、弹窗 | 宽折射带、弱位移、清晰中心 |
| `control` | 按钮、链接按钮、操作席位 | 小面积、中等位移、支持物理拖拽 |
| `field` | input、textarea、select | 中心安全区最大、极弱色散、焦点清晰 |
| `segmented` | 联排底座 | 一块平面，一个移动 slider |
| `item` | 气泡、席位、事件、徽章、提示 | 默认轻量材质；当前/悬停/交互项可升级单通道折射 |

原生输入控件不能包含子 lens，因此直接使用 `backdrop-filter`。该属性只采样控件后景，不过滤输入文字；普通 `filter:url()` 从不挂到原生内容上。

## 6. 光学算法

### 6.1 圆角距离场

位移图使用圆角矩形 signed-distance field。每个采样点计算到圆角边界的距离和法线：

```text
edge = smoothstep(内边界, 外边界, 到边缘距离)
dx = normal.x × edge
dy = normal.y × edge
R = 0.5 + dx / 2
B = 0.5 + dy / 2
G = edge mask
```

中心数学值严格为 `0.5`，编码像素为 128；SVG graph 对 128/255 的量化偏差再做校正。中心因此没有幽灵位移，月亮跨越面板时不会被整块复制。

边缘强度通过 `smoothstep` 单调增加，方向沿圆角边界法线，不再使用会在大面板上形成水平硬切的整幅横纵渐变。

### 6.2 清晰中心与边缘支路

```text
Backdrop SourceGraphic
  ├─ 原图 × 反向 edge mask ───────── clean center ─┐
  ├─ R 位移 ─ isolate R ─┐                         │
  ├─ G 位移 ─ isolate G ─┼─ screen ─× edge mask ─┼─ arithmetic add
  └─ B 位移 ─ isolate B ─┘                         │
                                                     ┘
```

三通道只存在于边缘 mask。单通道降级继续提供空间畸变，CSS 极窄彩边补充轻微色差；再超预算时降为普通 blur，最后才是 solid。

### 6.3 几何桶与资源池

位移图按以下键复用：

```text
role + 8px 宽高桶 + 2px 圆角桶 + DPR 桶 + normal/active + RGB/single
```

生成使用小型离屏 Canvas 将低频 SDF 编码为 PNG Blob。Canvas 只生成位移资源，不截图或重绘页面。编码使用 `toBlob()`，禁止 `toDataURL()`。

FilterPool 提供异步 `acquire()` lease：

- 同桶元素共享位移图和 SVG graph；
- 引用计数为零才允许 LRU 淘汰；
- 先移除 `<feImage>` graph，再 revoke Blob URL；
- 默认按解码 RGBA 字节而非压缩 PNG 大小控制缓存；
- 生成优先进入 `requestIdleCallback`，首次绘制先显示稳定基础材质。

## 7. 自动性能预算

优先级：

```text
当前交互 > 顶栏/弹窗 > 主面板 > 字段/按钮 > 当前气泡/席位 > 普通重复项
```

桌面初始预算：

- 3 个静态 RGB + 1 个交互 RGB；
- RGB 面积不超过约 25% 视口；
- 最多 8 个单通道实例；
- 总折射面积不超过约 45% 视口。

移动/低档初始预算：

- 1 个静态 RGB + 1 个交互 RGB；
- RGB 面积不超过约 12% 视口；
- 最多 4 个单通道实例；
- 总折射面积不超过约 25% 视口。

离开视口后质量直接变为 `solid` 并释放 lease。节点删除、React 路由切换、弹窗关闭和切回原版都会注销 observer 和滤镜资源。

滚动或拖拽时临时采样约 1 秒帧间隔。p95 持续高于 24ms 时使用移动预算；恢复需要更长稳定窗口，避免质量档抖动。系统不会常驻性能 RAF。

## 8. 三档动效

### 无动效 `none`

- 不进行空间移动、拉伸、倾斜、桥接或过冲；
- 联排直接吸附；
- 背景只短淡入；
- 不启动弹簧 RAF。

`prefers-reduced-motion: reduce` 会把有效动效强制降到本档。

### 标准动效 `standard`

- 使用现有锚定短拖概念；
- 橡皮筋限制移动范围；
- 方向性拉伸和有限惯性；
- 释放后欠阻尼 Q 弹回锚点；
- 稳定后完全停止 RAF；
- 旧 V3 的 `full` 自动迁移到本档，保持原有用户体验。

### 完整动效 `full`

- 指针位置成为压力中心；
- 按下位置局部增深折射和高光；
- 指针速度驱动方向拉伸、rotateX/rotateY 和倾斜；
- 快速停止时玻璃质量可有限越过指针，再由弹簧拉回；
- 每帧只写 transform 与 CSS 变量，不创建光学资源；
- 一次只允许一个普通控件拥有完整物理状态。

联排滑块保留自己的几何弹簧和溶球桥接，普通 MotionEngine 会忽略 option 和 slider，避免两套代码争抢同一 transform。

## 9. 绘制顺序

```text
z=0   昼夜背景
z=10  页面正文
z=30  顶栏、房间栏、移动导航
z=40  弹窗与当前拖拽物
z=50  toast、同步错误、焦点前景
```

顶栏在正文之后绘制，因此能够折射正文；正文按钮在顶栏之前绘制，因此不能读取顶栏。导航 lens 还使用纵向遮罩，让折射向内逐渐消失，而不是整条顶栏持续模糊。

## 10. 背景、明暗和染色

背景支持：

1. 东方幻想、电影概念、梦境月影三套内置昼夜图；
2. 本机自定义单图；
3. 本机自定义昼夜双图。

自定义图片 Blob 只保存在 IndexedDB，不上传服务端。单图在游戏阶段变化时保持不变；双图和内置图按日夜阶段切换。

大厅明暗支持跟随系统、亮色和暗色。暗色模式降低背景亮度但不把测试版夜景压黑；当前目标亮度约 `.9`。

自动取色将图片降采样到最多 48×48，排除近黑、近白、透明和低饱和噪声，再选较深且有明确色相的主色。无染色时不保留任何默认脏底。

## 11. 代码对应

- `src/runtime/visualPreferences.ts`：V4 偏好、三档动效和 V1–V3 迁移；
- `src/runtime/visualBackgroundStore.ts`：本地背景 Blob；
- `src/runtime/visualTintExtractor.ts`：本地主色提取；
- `src/runtime/visualEffectsRuntime.ts`：背景资源与 GlassRuntime 生命周期；
- `src/visual/glass/glassTypes.ts`：稳定类型；
- `glassProfiles.ts`：六类表面参数；
- `glassFilterPool.ts`：SDF、SVG graph、共享 lease/LRU；
- `glassQualityController.ts`：纯函数预算分配；
- `glassSurfaceRegistry.ts`：显式角色与遗留兼容映射；
- `glassMotionMath.ts`：可测试物理计算；
- `glassMotionEngine.ts`：普通控件共享动效；
- `glassRuntime.ts`：运行时总编排与诊断；
- `src/ui/DragSegmented.tsx`：联排滑块、拖动切换和三档动效接入；
- `src/styles/glass/`：唯一材质样式权威。

旧 `buttonPullInteraction.ts`、`opticalEdgeRuntime.ts`、静态 `public/visual/glass-*-map.png` 和对应测试已被替换，不再属于系统。

## 12. 如何给新组件接入玻璃

优先在现有语义宿主上声明角色，不添加影响 flex/grid 的包装：

```tsx
<section data-glass-role="panel">…</section>
<button data-glass-role="control" data-glass-motion="control">…</button>
<input data-glass-role="field" />
<article data-glass-role="item">…</article>
```

特殊优先级可声明：

```tsx
<div data-glass-role="panel" data-glass-priority="high">…</div>
```

不应做的事：

- 给联排 option 增加 lens；
- 给包含文字的宿主使用普通 `filter:url()`；
- 在页面私有 CSS 中再写一套材质；
- 为 hover/pointermove 重建 SVG；
- 常驻 `will-change:filter`；
- 通过提高 `z-index` 让正文控件越过顶栏。

## 13. 验收与维护

关键命令：

```text
npm run check
npm run test:ui
npm run lint -- --max-warnings=0
npm run build
npm run check-bundle-budget
```

测试必须覆盖：

- SDF 中心严格中性；
- 边缘强度单调增加并沿圆角法线；
- clean center + edge-only RGB graph；
- FilterPool 共用、LRU、异步 dispose；
- RGB/单通道/blur/solid 预算顺序；
- 三档动效、误点击、capture 和停帧；
- UI 原语显式角色；
- 联排单一光学所有权；
- 透明模式零 blur；
- 无旧标识、无 `!important` 覆盖堆。

最终视觉仍需人工查看高对比背景：让月亮、棋盘线和细文字跨越面板/顶栏边缘，确认没有硬横线、完整副本、中心模糊或文字 RGB 重影。

## 14. 备份与恢复

本轮实装前备份：

`server-fix-work/backups/ww_v3_before_global_liquid_glass_20260831-075546.zip`

SHA256：

`6833308237B41A6B637EE594050F32ED469106F9F88762620F84A088D3AB8D64`

该备份包含实装前的未提交工作树，但排除了 `.git`、`node_modules`、`dist` 和临时测试输出。已删除的旧二进制位移图可从备份恢复。
