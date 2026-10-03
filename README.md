# 桥梁支座更换与顶升监测台（sologsb101-1005 / gbbridgebear）

## 一、Docker 一键启动（推荐）

```bash
cd sologsb101-1005
cp .env.example .env
docker compose up -d --build
```

启动后访问：**http://localhost:22805**

停止与清理：

```bash
docker compose down          # 停止并删除容器
docker compose up -d --build # 代码改动后重建
```

## 二、项目简介

面向桥梁养护项目的技术员与施工班组，按墩台编排支座更换作业，并在顶升过程中按测点逐级记录位移与应力，最后分步验收归档。

核心动作：

- 建立桥梁与墩台台账（跨径组合、桥型、建成年、公路等级、盖梁标高）
- 登记支座并按完好 / 轻微 / 较重 / 严重四级评定病害，较重及以上触发更换建议，支持批量调级与升级
- 编排分级顶升步骤（目标顶升量、同步要求、限位值、负责人），支持上移 / 下移调序与**累计顶升量校验**
- 按步骤批量录入多测点位移与应力，实时计算**同步偏差**（同批次极差）并按限位值给出告警
- **离线整库合并**：两组平板各自离线记录后回机，导入对方整库 JSON 时不信任设备记录号，先按「桥梁名称 + 步骤序号 + 测点编号」挂回本机步骤并按顺序暂存；同测点两边数值不同并列保留，逐项确认后才进入正式读数；写入失败可从检查点继续，重试同一包（按内容摘要判重）不会重复建档；缺少应力字段的旧数据按缺测兼容读入
- 正式读数确认后自动**重算累计顶升量（目标 / 实测）、同步偏差与超限告警**，并更新支座验收归档条件
- 四步签署验收（顶升到位 → 支座就位 → 落梁 → 竣工），全部支座合格后可执行竣工归档
- 查看 IndexedDB 结构版本并导出 / 导入整库 JSON

本项目为**纯前端单页应用**：无后端、无数据库服务、无外部接口，全部数据保存在浏览器 IndexedDB。

## 三、技术栈

| 分类 | 选型 | 版本 |
| --- | --- | --- |
| 框架 | Angular | 18.2 |
| 语言 | TypeScript | 5.5 |
| UI 组件库 | Angular Material + CDK | 18.2 |
| 响应式 | RxJS | 7.8 |
| 状态管理 | NgRx（@ngrx/store + effects + store-devtools） | 18.1 |
| 路由 | Angular Router（懒加载 + Hash 策略） | 18.2 |
| 本地持久化 | Dexie（IndexedDB） | 4.0 |
| 构建 | @angular-devkit/build-angular:application | 18.2 |
| 容器 | 多阶段构建 node:20-alpine → nginx:alpine | — |

## 四、路由一览

| 路由 | 页面组件 | 说明 |
| --- | --- | --- |
| `/bridges` | `BridgeListPage` | 建立桥梁与墩台台账，按桥型与建成年筛选 |
| `/bearings` | `BearingBoardPage` | 登记支座规格并评定病害等级，按等级批量处置 |
| `/steps` | `StepPlanPage` | 顶升步骤编排、顺序调整与累计顶升量校验 |
| `/readings` | `ReadingEntryPage` | 按步骤批量录入位移与应力，同步偏差与限位告警 |
| `/acceptances` | `AcceptanceArchivePage` | 四步签署、竣工归档与结构版本 JSON 导出 / 导入 |

> 路由定义在 `src/app/core/router/app.routes.ts`，使用默认的 `PathLocationStrategy`（history 模式），与 nginx 的 `try_files $uri $uri/ /index.html` 配合，直接访问上述深链接（含刷新）都能命中对应页面。

## 五、目录结构

```
sologsb101-1005/
├── README.md
├── docker-compose.yml                    # 顶层 name: gbbridgebear，无 version 字段
├── .env / .env.example                   # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile                        # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf                        # try_files 前端路由回退 + gzip
    ├── .dockerignore
    ├── package.json / angular.json / tsconfig.json / tsconfig.app.json
    ├── public/favicon.svg
    └── src/
        ├── main.ts                       # bootstrapApplication(AppComponent, appConfig)
        ├── index.html
        ├── styles.scss                   # Angular Material 主题 + 全局样式
        └── app/
            ├── app.component.ts          # 应用外壳（工具栏 + 侧边导航 + 统计）
            ├── app.config.ts             # provideRouter / provideStore / provideEffects
            ├── core/
            │   ├── types/                # bridge.ts pier.ts bearing.ts step.ts reading.ts acceptance.ts persistence.ts merge.ts
            │   ├── store/                # app.actions.ts notice.reducer.ts archive.helper.ts
            │   │                         # *.actions/reducer/selectors、app.effects.ts、merge.effects.ts
            │   ├── services/             # idb-table.service.ts step-timeline.service.ts merge.service.ts change-bus.service.ts
            │   ├── router/app.routes.ts
            │   └── utils/                # unit.ts tolerance.ts db.ts export.ts merge-packet.ts
            ├── shared/components/common/ # grade-tag / filter-bar / stat-badge / empty-panel / pending-review-dialog
            └── features/
                ├── bridges/pages/bridge-list.page.ts
                ├── bearings/pages/bearing-board.page.ts
                ├── steps/pages/step-plan.page.ts
                ├── readings/pages/reading-entry.page.ts
                └── acceptances/pages/acceptance-archive.page.ts
```

## 六、数据存储说明

- **存储介质**：浏览器 IndexedDB，库名 **`gbbridgebear`**，通过 Dexie 4.x 封装。
- **数据结构版本**：`core/utils/db.ts` 中 `DB_SCHEMA_VERSION = 3`，登记 v1 → v2 → v3 的 `upgrade` 迁移：
  - v1 → v2：补齐行修订号、迁移 `span → spanCombo`、`grade → diseaseGrade`、`syncType → syncRequirement`、`limit → limitMm`，新增 `settings` 表。
  - v2 → v3：新增离线合并的 `pendingReadings`（暂存读数）与 `importJobs`（导入任务 / 写入检查点）两张表；历史读数缺少应力字段时迁移为 `stressMpa = null` + `stressMissing = true`，告警按仅位移口径降级。
- **数据表**：

  | 表名 | 实体 | 主要索引 |
  | --- | --- | --- |
  | `bridges` | 桥梁 | id / name / bridgeType / builtYear / roadClass / archived |
  | `piers` | 墩台 | id / bridgeId / code / capElevation / [bridgeId+code] |
  | `bearings` | 支座 | id / pierId / diseaseGrade / type / serial / [pierId+serial] |
  | `steps` | 顶升步骤 | id / bridgeId / seq / state / syncRequirement / [bridgeId+seq] |
  | `readings` | 测点读数（正式） | id / stepId / pointCode / recordedAt / [stepId+pointCode] |
  | `pendingReadings` | 离线合并暂存读数 | id / jobId / packageHash / resolvedStepId / status / [jobId+ordinal] |
  | `importJobs` | 导入任务与检查点 | id / packageHash / state / phase / updatedAt |
  | `acceptances` | 分步验收 | id / bearingId / stage / conclusion / [bearingId+stage] |
  | `settings` | 自定义字典 | id |

- **离线合并机制**（入口：测点读数录入页「离线合并」面板，核心在 `core/services/merge.service.ts` 与 `core/utils/merge-packet.ts`）：
  1. 整包归一化后计算内容摘要（FNV-1a）作为任务主键；同一包重复导入直接复用任务，不重复建档。
  2. 设备读数只按桥梁名称 + 步骤序号 + 测点编号挂接本机步骤（设备 id / 记录号仅留痕），挂不上的标记为无法挂接。
  3. 分批（30 条 / 批）顺序写入暂存表，每批落一次检查点；中断后「从检查点重试」只补剩余部分。
  4. 同测点多设备数值不同在核对对话框中并列保留；每组至少采纳一条，确认结果用确定性正式读数 id 写入 `readings`，重试不会产生重复正式读数。
  5. 正式读数落地后广播变更，累计顶升量（实测口径取每步最后一轮读数均值并逐桥累计）、同步偏差、超限告警由 NgRx / RxJS 派生流自动重算，并重算支座验收归档摘要。
  - 端到端验证：`npm run test:merge`（fake-indexeddb + esbuild 打包到 Node 运行）。

- **首屏自动播种**：`initDatabase()` 在 `bridges` 表为空时写入演示数据（幂等）——2 座桥梁 × 各 2~3 个墩台 × 各 2~3 个支座（四级病害各覆盖）+ 2~3 级顶升步骤 + 每级多测点读数 + 分步验收记录，父子记录通过 `bridgeId / pierId / bearingId / stepId` 互相引用。
- **跨页状态**：全部放在 NgRx store（`bridge / bearing / step / acceptance` + `notice` 提示），页面只通过 `select` 读 store、通过 `dispatch` 写；Dexie 写入后由 `ChangeBusService` 广播，`AppEffects` 重新加载全部表。
- **数据不出浏览器**：容器无状态，不挂载卷、不使用数据库服务。

## 七、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22805（ng serve）
npm run typecheck  # tsc --noEmit -p tsconfig.app.json
npm run test:merge # 离线合并端到端验证（fake-indexeddb）
npm run build      # ng build（含 Angular 模板类型检查与 TS 校验）
```

## 八、容器化细节

- `Dockerfile` 两阶段构建：`node:20-alpine` 安装依赖并执行 `npm run build`，随后把 `dist/gbbridgebear/browser` 拷贝到 `nginx:alpine` 的 `/usr/share/nginx/html`。
- 运行阶段在 COPY 之后执行 `RUN chmod -R a+rX /usr/share/nginx/html`，规避历史遗留的 favicon 权限 0600 导致 nginx 403 的问题。
- `nginx.conf` 使用 `try_files $uri $uri/ /index.html;` 支持前端路由直接刷新，并开启 gzip。
- `docker-compose.yml` 不写 `version:`，顶层 `name: gbbridgebear` 兜底（避免中文目录名导致项目名为空），服务名 `frontend`，容器名 `${COMPOSE_PROJECT_NAME:-gbbridgebear}-frontend`，端口 `${FRONTEND_PORT:-22805}:80`，`restart: unless-stopped`。
