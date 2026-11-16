# Licensing

This repository contains more than one license. The root [`LICENSE`](../LICENSE)
(MIT) applies to **new OpenTeamily-authored material only**. It does not
relicense imported upstream trees.

| Tree | License | Binding files | Copyright / notice |
| --- | --- | --- | --- |
| New OpenTeamily code and docs (`openteamily/`, `manager/`, `tests/`, `docs/` except copied upstream docs, `scripts/` authored here) | MIT | [`LICENSE`](../LICENSE) | OpenTeamily contributors |
| `runtime/flybot/` (except `ORIGIN.md` and `OPENTEAMILY.md`) | Apache License 2.0 | [`runtime/flybot/LICENSE`](../runtime/flybot/LICENSE), [`runtime/flybot/NOTICE`](../runtime/flybot/NOTICE) | NOTICE: DS Bot, Copyright 2026 Fei2411 and the DS Bot contributors |
| `services/bot-social/` (except `ORIGIN.md` and `OPENTEAMILY.md`) | MIT | [`services/bot-social/LICENSE`](../services/bot-social/LICENSE) | Copyright (c) 2026 Birfy |
| `runtime/ds-bot-upstream/` (except `UPSTREAM.md`) | Apache License 2.0 | [`runtime/ds-bot-upstream/LICENSE`](../runtime/ds-bot-upstream/LICENSE), [`runtime/ds-bot-upstream/NOTICE`](../runtime/ds-bot-upstream/NOTICE) | Unmodified pinned copy of [Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot) v0.3.6 (`a66cc737cfb6c3d8a2597e748cded6cab1206dd3`); LICENSE and NOTICE retained |

`ORIGIN.md` and `OPENTEAMILY.md` files inside imported FlyBot and Bot Social
trees, and `UPSTREAM.md` inside `runtime/ds-bot-upstream/`, are OpenTeamily
documentation overlays and follow the root MIT license. They do not change the
license of neighboring upstream files.

If you redistribute this repository, include the Apache-2.0 text and NOTICE
with the FlyBot snapshot and with the unmodified `runtime/ds-bot-upstream/`
copy, include the Bot Social MIT copyright notice, and do not describe the
combined work as “all MIT” or “all original to OpenTeamily.”
