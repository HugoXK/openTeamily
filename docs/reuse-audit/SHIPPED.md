# 已交付修订的来源与许可清单

审计日期：2026-11-16（Asia/Shanghai）。  
对照提交：`openTeamily/openTeamily` `origin/main` `e67e712f9f8389f842c33d204e6c6e6a0014df73`，外加本目录本次新增的清单与根 `NOTICE`。  
本文件是对**当前仓库实际交付内容**和**运行时镜像配方会安装的组件**的书面清单，不是法律意见，也不构成再分发授权。根 MIT **不**覆盖导入树，也**不**覆盖镜像配方在构建时从 npm / Debian 拉入的第三方包。相关跟踪仍保持开放：issue 1、issue 3、issue 5。在下文「发布前的阻塞项」解决之前，**不得**把本仓镜像配方宣称为已审计的可再分发公开发行物。

机器可读钉扎见 [shipped-pins.json](shipped-pins.json)。#18 对既有来源的审计记录仍在 [README.md](README.md) 与 [pins.json](pins.json)；本文件不追溯改写那些结论。Project / Timeline 的静态风险仍以 #18 记录为准，这两个插件**未被导入**；若日后复用须先修那些风险。

方法：只读本仓库已提交文件、公开 npm 注册表元数据，以及通过 GitHub 读取的 `deepseek-ai/deepseek-harness` 标签 `dsh-v0.2.2-rc.1`（提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`）上的 `LICENSE`、`THIRD_PARTY_NOTICES.md` 和 `Montserrat-OFL.txt`。未执行 `npm install`，未展开完整传递闭包，本机没有 Docker，因此没有对构建成品做文件清单。npm 的 `license` 字段不能代替逐文件阅读上游 LICENSE。

## 1. 本仓库内的许可文本

| 路径 | 许可 | sha256 | 字节 |
| --- | --- | --- | --- |
| [`LICENSE`](../../LICENSE)（仅覆盖新撰写的 OpenTeamily 材料） | MIT，Copyright (c) 2026 OpenTeamily contributors | `096841e8f7eceada5cbb435b01e60cedc2b458717c2065131ad64e1d7bebad6a` | 1081 |
| [`NOTICE`](../../NOTICE)（根说明，指向下列树与镜像义务） | 说明文件 | 以仓库当前文件为准 | — |
| [`runtime/flybot/LICENSE`](../../runtime/flybot/LICENSE) + [`NOTICE`](../../runtime/flybot/NOTICE) | Apache-2.0 + NOTICE | LICENSE `c71d239d…0ab4`（11357）；NOTICE `94f05bc4…27ca`（3835） | 与 #18 ThinkFlowLab/FlyBot `@e26895e7` 记录一致 |
| [`runtime/ds-bot-upstream/LICENSE`](../../runtime/ds-bot-upstream/LICENSE) + [`NOTICE`](../../runtime/ds-bot-upstream/NOTICE) | Apache-2.0 + NOTICE；未修改的 Fei2411/DS-Bot v0.3.6（`a66cc737cfb6c3d8a2597e748cded6cab1206dd3`） | LICENSE 与上项相同；NOTICE `4c7d3e4e7607f02ed9e4fb940442be7d0d107b57beb54660e1526a7be07c2aad`（15557） | NOTICE 长于历史钉扎 `94f05bc4…`（3835）。本次只核哈希，**不是**对新增声明的逐条法律重读 |
| [`services/bot-social/LICENSE`](../../services/bot-social/LICENSE) | MIT，Copyright (c) 2026 Birfy | `6f5b168b7397507ec7854d3787079ae4185826ea0a9ade831a269fabe3e737c3` | 1062 |

新撰写且声明 MIT 的运行时包：`runtime/flybot-image`、`runtime/flybot-image/plugin`、`runtime/flybot-social-host`、`runtime/flybot-web-slots`、`runtime/flybot-web-slots/social-web`（均 `license: MIT`）。`manager/compose-planner/package.json` 没有 `license` 字段，按根 MIT 覆盖的新撰写材料处理，除非日后证明另有来源。`ORIGIN.md` / `OPENTEAMILY.md` / `UPSTREAM.md` 是 OpenTeamily 文档覆层，适用根 MIT，不改变相邻上游文件的许可。

管理面（`openteamily/`）为 Python 3 标准库实现，本仓库没有 Python 第三方 `requirements` 锁。CI 使用钉扎的 GitHub Actions：`actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803`（v6）、`actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`（v4.4.0）以及部分工作流中的 `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1`（v7.1.0）、`actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1`（v6）。这些是 CI 用软件，不是运行时镜像内容。

未获许可的 [Birfy/flybot-control-plane](https://github.com/Birfy/flybot-control-plane) **仍禁止导入**（根目录无 LICENSE）。商标与品牌资产仍待核，不得把 Teamily 专有资产或未核商标的标识导入本仓。

## 2. 已纳入仓库的 npm 锁（会随 `npm ci` 进入镜像或服务）

这些锁文件在仓库中；`node_modules` 不在仓库中。许可结论如下。

### `runtime/ds-bot-upstream/ds-bot/package-lock.json`

锁版本 3，93 个包，**全部带有** `license` 字段：MIT 77、Apache-2.0 4、BSD-2-Clause 5、BSD-3-Clause 2、ISC 3、MIT-0 1、`(MIT OR EUPL-1.1+)` 1。未见 GPL / AGPL / MPL。

双许可项：`@zone-eu/mailsplit@5.4.29` 声明 `(MIT OR EUPL-1.1+)`，integrity `sha512-CCUNycmUjrV5M0wNf23waWAt9eOHczhjLbUQS7k0FNJvR0py9VSqHFt+tSl/D0+XI73VLG0U+PwYtq9R0zsm9Q==`。再分发者可以选择 MIT；本清单不把它写成「仅 MIT」。

`runtime/ds-bot-upstream/link/package-lock.json`：16 个包，MIT 15、Apache-2.0 1，无缺失字段，未见 copyleft。

### `services/bot-social/package-lock.json`

锁版本 3，227 个条目、223 个唯一 `name@version`。该锁**本身没有** `license` 字段。2026-11-16 按唯一版本向 `registry.npmjs.org` 查询声明许可，结果：MIT 178、Apache-2.0 24、ISC 12、BSD-3-Clause 6、BSD-2-Clause 1、`(MIT OR WTFPL)` 1（`expand-template@2.0.3`）、`(BSD-2-Clause OR MIT OR Apache-2.0)` 1（`rc@1.2.8`）。无查询失败，未见 GPL / AGPL / MPL / “SEE LICENSE”。这是注册表字段，不是对每个包 LICENSE 文件的逐一阅读。完整表在 `shipped-pins.json`。

Bot Social 是可选适配，不是架构必选第三服务。

## 3. 运行时镜像配方会安装、但未全部钉在本仓中的组件

配方：[`runtime/flybot-image/Dockerfile`](../../runtime/flybot-image/Dockerfile)。基础镜像 `node:24-bookworm-slim`。构建阶段安装 `python3`、`make`、`g++`；运行阶段安装 `ca-certificates`、`git`、`curl`。然后全局安装 `@deepseek-ai/dsh@0.2.2-rc.1`，在已供应商的 ds-bot 树上执行 `npm ci`，并再安装 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-scope`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-web`（均为 `0.2.2-rc.1`）。配方还允许若干原生包的 install scripts（含 `node-pty`、`koffi`、`@google/genai` 等）；`@google/genai` **不是** `@deepseek-ai/dsh@0.2.2-rc.1` 的生产直接依赖，它是否进入默认安装闭包未在本次用锁展开证明。

### 3.1 `@deepseek-ai/dsh@0.2.2-rc.1`

| 项 | 记录 |
| --- | --- |
| npm 声明许可 | MIT |
| tarball | https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.2-rc.1.tgz |
| integrity | `sha512-ijR9UEVYkG15Q/Q79JzvzLBzQOQfc63VLr9n6flpwHPhr5IKn2UxthnSoto/P9l7qGd7pPvI1Ra6TW7LH3oKpg==` |
| shasum | `95d1cf510061a57c97b4a68d43336658bcec6af1` |
| 注册表 `gitHead` | **无** |
| 对应 git 标签 | `dsh-v0.2.2-rc.1` → 提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`（2026-11-04T07:54:45Z） |
| tarball 与 git 标签的字节对应 | **未核实** |
| 该标签上 `LICENSE` | sha256 `ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be`（1065 字节），与 #18 所核 `dsh-v0.2.1-rc.2` 的 LICENSE 相同 |
| 该标签上 `THIRD_PARTY_NOTICES.md` | sha256 `4bd8832885ca31daf3e480fb950b9e849446438c0089b05fab67d6c2673fa2ef`（26763 字节），**不同于** #18 的 `aeea7aa2…`（25003 字节） |
| 该标签上 `Montserrat-OFL.txt` | sha256 `861d64229728cd65a98d119612c12769582574d1a092f0b63c8b0fd474e7065f`（4400 字节），SIL Open Font License 1.1。若再分发包含该字体的 UI，须保留 OFL 文本，不得改许可，也不得单独出售字体。本次未从构建成品中确认字体文件是否被拷入默认镜像。 |

该 CLI 包有 **90** 个生产直接依赖。向 npm 查询后，这 90 个在已声明的确切版本或（8 个范围声明的）满足范围的候选版本上，**全部声明 MIT**。8 个范围为：`@deepseek-ai/cordis@~4.1.0`（候选 4.1.0）、`cordis-plugin-include@~1.1.0`、`cordis-plugin-loader@~1.1.0`、`cordis-plugin-timer@~1.2.0`、`schemastery@~3.19.0`、`commander@^15.0.0`（候选 15.1.0）、`js-yaml@^4.3.2`（候选 4.3.2，不是 5.x）、`node-addon-require-builtin@^0.1.9`（候选 0.1.9）。这些候选是 2026-11-16 注册表上满足范围的版本，**不是**锁文件钉扎。完整表见 `shipped-pins.json`。已解析的 `@deepseek-ai/*@0.2.2-rc.1` 包同样没有 `gitHead`。

### 3.2 MPL-2.0：`@deepseek-ai/libreoffice-kit`（发布阻塞）

`@deepseek-ai/dsh-skill-office@0.2.2-rc.1`（MIT）是上述 90 个生产直接依赖之一，并依赖 `@deepseek-ai/libreoffice-kit@^0.1.5`。`^0.1.5` 的候选版本 `0.1.5` 声明 **MPL-2.0**，integrity `sha512-H12xtUsAyl70zFeQ5pk5GGRc3N1+6zn+DVAcqwlguI6EvqopBGP3xkUmePU7g5f6ydYlDZLWedHT9lTSL7zLxA==`。其直接依赖为 `koffi@3.1.1`、`saxes@6.0.0`、`fflate@0.8.2`、`fontkit@2.0.4`（`fontkit` 声明 MIT）。注册表上另有 `0.2.3`（亦为 MPL-2.0），但不在 `^0.1.5` 范围内。

DSH `dsh-v0.2.2-rc.1` 的 `THIRD_PARTY_NOTICES.md` 写明该 kit 及其平台包声明 MPL-2.0，且「Recipients must have access to those corresponding sources and notices。」默认执行配方中的 `npm install -g @deepseek-ai/dsh@0.2.2-rc.1` 就会经由 office 技能带入该组件，除非构建时明确排除。在履行对应源码提供义务，或从默认镜像中排除 office 技能 / kit 之前，这是**公开发行镜像的法律阻塞项**。本仓库目前**不**提供该 kit 的对应源码要约。

### 3.3 Claude / Anthropic 载荷（未证明是否进入默认镜像）

`@anthropic-ai/claude-agent-sdk` **不是** `@deepseek-ai/dsh@0.2.2-rc.1` 的生产直接依赖。CLI 包的 `devDependencies` 含 `@deepseek-ai/dsh-hooks-claude-code@0.2.2-rc.1`（声明 MIT，其直接依赖只有 `schemastery`）。按通常的 `npm install -g` 行为，devDependencies 不会被安装，但这不是对完整闭包的证明。

同一标签的 `THIRD_PARTY_NOTICES.md` 仍列出官方 `@anthropic-ai/claude-agent-sdk`（声明 “SEE LICENSE IN README.md”）及其 0.3.263 平台可选包（声明 “SEE LICENSE IN LICENSE.md”），并写明这套条款不被当作宽松许可。本次**未阅读**那些 README / LICENSE.md 正文，也**未证明**默认镜像不含这些载荷。在条款核清且能证明默认安装不会分发它们之前，不得宣称「完整 DSH 运行时已可再分发」。

### 3.4 其它未完成项

- KaTeX 在 DSH 通知中列为 MIT；其发行中的字体附件是否另有 OFL / 附属文本，本次未逐文件核对。
- `node:24-bookworm-slim` 以及镜像内 Debian 组件（至少包括 `git`，GPL-2.0）的版权清单与源码提供方式，本次未枚举。发布镜像前须补齐。
- 配方中的 `pnpm --dir /opt/dsh-template/profiles/web install` 会再拉一层依赖，本次未展开。
- 上游 DS-Bot v0.3.6 NOTICE 的新增第三方声明尚未逐条法律重读（哈希已记录）。

## 4. 建议动作

| 对象 | 建议 |
| --- | --- |
| 本仓新撰写材料、管理面、自写 stub | 可按根 MIT 再分发源码；保留根 LICENSE 与 NOTICE，并附带导入树的许可文本。 |
| 已导入的 FlyBot / DS-Bot / Bot Social 树 | 保持原许可与 NOTICE / 版权，不得改标为本仓 MIT。 |
| 自托管构建本镜像供自己运行 | 可以按配方构建；CI 已证明镜像能构建并启动。这不等于已取得公开发行授权。 |
| 公开发布预构建运行时镜像或其它发行物 | **先不要做。** 至少需要：处理 LibreOffice kit 的 MPL 源码义务或从默认镜像排除它；枚举基础镜像与 `git` 等 Debian 组件并准备源码要约；展开并记录默认安装的完整依赖闭包；核实 npm tarball 与 git 标签对应；核清 Claude 载荷条款及其是否进入默认镜像；按需处理 OFL 字体。 |
| Project / Timeline 插件 | 现在不复制；若复用须先修 #18 记录的静态风险。 |
| Birfy/flybot-control-plane | 禁止导入。 |

## 5. 因此 issue 3 仍保持开放的原因

书面清单已经覆盖当前仓库交付的主要来源、版本、声明许可、已知限制和建议动作，并记录了 #18 的 Project / Timeline 风险。下列事项仍然未知或未解决，因此不能把 issue 3 写成已经完成，也不能把本仓镜像称为可再分发的公开发行物：

1. MPL-2.0 LibreOffice kit 会随默认 DSH 安装进入镜像，对应源码要约尚未提供，也尚未从配方中排除。
2. `@deepseek-ai/dsh@0.2.2-rc.1` 的 npm tarball 与 git 标签 `dsh-v0.2.2-rc.1` 尚未做字节对应。
3. 默认镜像的完整传递依赖闭包（含全局 DSH、ds-bot 额外包、profile `pnpm install`）尚未展开。
4. 基础镜像与 Debian/`git` 的版权清单与源码提供方式尚未枚举。
5. Claude 官方载荷的条款未阅读，是否进入默认镜像未证明。
6. KaTeX 字体附件与 v0.3.6 NOTICE 新增声明尚未逐条核对；商标待核。

校验：在仓库根目录运行 `python3 scripts/verify-reuse-audit-pins.py`（离线检查历史钉扎与本清单哈希）。`python3 -m unittest tests.test_shipped_licenses` 检查根 NOTICE / 导入树许可文件是否存在，且磁盘哈希与 `shipped-pins.json` 一致。
