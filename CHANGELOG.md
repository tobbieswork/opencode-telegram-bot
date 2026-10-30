# Changelog

## [1.9.1](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.9.0...opencode-telegram-bot-v1.9.1) (2026-10-30)


### Bug Fixes

* **ask:** guard /ask against silent-drop on unexpected throw ([#105](https://github.com/tobbieswork/opencode-telegram-bot/issues/105)) ([#95](https://github.com/tobbieswork/opencode-telegram-bot/issues/95)) ([8875354](https://github.com/tobbieswork/opencode-telegram-bot/commit/8875354ceac126bec3e78875571539bd6b2bb407))

## [1.9.0](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.8.0...opencode-telegram-bot-v1.9.0) (2026-10-30)


### Features

* /review bot command + stronger review-code skill ([#88](https://github.com/tobbieswork/opencode-telegram-bot/issues/88)) ([121577f](https://github.com/tobbieswork/opencode-telegram-bot/commit/121577fb8b4ff35b47f1c6bb2082c521a5af6d40))

## [1.8.0](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.7.0...opencode-telegram-bot-v1.8.0) (2026-10-30)


### Features

* **advisor:** Claude + Gemini advisor with one-command setup; remove Mac node ([#89](https://github.com/tobbieswork/opencode-telegram-bot/issues/89)) ([cfaa8a4](https://github.com/tobbieswork/opencode-telegram-bot/commit/cfaa8a49bd41ae0d397fc087f9659438f2032e07))

## [1.7.0](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.6.0...opencode-telegram-bot-v1.7.0) (2026-10-30)


### Features

* **rotation:** add /rotation + rotation-history / durability tracking (Part 1) ([#91](https://github.com/tobbieswork/opencode-telegram-bot/issues/91)) ([7829c94](https://github.com/tobbieswork/opencode-telegram-bot/commit/7829c94fbbb5a90810fc97312b5ade883f61563a))

## [1.6.0](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.5.0...opencode-telegram-bot-v1.6.0) (2026-10-30)


### Features

* **manager:** auto-rotate Manager session on context-floor drift ([#86](https://github.com/tobbieswork/opencode-telegram-bot/issues/86)) ([2b450c5](https://github.com/tobbieswork/opencode-telegram-bot/commit/2b450c599246af3ff858d2f2b9655d86ec3604fe))

## [1.5.0](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.4.1...opencode-telegram-bot-v1.5.0) (2026-10-30)


### Features

* add /review command + review-code skill to project ([#84](https://github.com/tobbieswork/opencode-telegram-bot/issues/84)) ([7605bb1](https://github.com/tobbieswork/opencode-telegram-bot/commit/7605bb19d8529779a263ee49d6a200fdb1b684c9))

## [1.4.1](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.4.0...opencode-telegram-bot-v1.4.1) (2026-10-29)


### Bug Fixes

* graceful shutdown drains in-flight turns before exit on restart ([#82](https://github.com/tobbieswork/opencode-telegram-bot/issues/82)) ([74ba3d7](https://github.com/tobbieswork/opencode-telegram-bot/commit/74ba3d75e3aedf1c2d52a0fb31dadcca4e5f9862))

## [1.4.0](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.3.5...opencode-telegram-bot-v1.4.0) (2026-10-29)


### Features

* **advisor:** Claude advisor — manager consults Claude on the Mac over Tailscale ([#80](https://github.com/tobbieswork/opencode-telegram-bot/issues/80)) ([cc3b6c2](https://github.com/tobbieswork/opencode-telegram-bot/commit/cc3b6c2bbfe4aa0bbb898f55bf6c7887ae6e65d5))

## [1.3.5](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.3.4...opencode-telegram-bot-v1.3.5) (2026-10-29)


### Bug Fixes

* **node:** đổi branch code sang node-code/&lt;id&gt; (xung đột ref) + plist 0600 ([#75](https://github.com/tobbieswork/opencode-telegram-bot/issues/75)) ([f7ddffc](https://github.com/tobbieswork/opencode-telegram-bot/commit/f7ddffc87bd1d7634f2a1ef54c963217f071a445))

## [1.3.4](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.3.3...opencode-telegram-bot-v1.3.4) (2026-10-29)


### Bug Fixes

* **bridge:** self-heal tg-bridge after OpenCode context reload ([#76](https://github.com/tobbieswork/opencode-telegram-bot/issues/76)) ([d943bde](https://github.com/tobbieswork/opencode-telegram-bot/commit/d943bdeb5a3454783a1ca8b1f8d0b643c8535769))

## [1.3.3](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.3.2...opencode-telegram-bot-v1.3.3) (2026-10-29)


### Bug Fixes

* **node:** daemon clone SSH→HTTPS + MAC_NODE_GIT_TOKEN (launchd has no ssh-agent) ([#73](https://github.com/tobbieswork/opencode-telegram-bot/issues/73)) ([b904505](https://github.com/tobbieswork/opencode-telegram-bot/commit/b9045056253391b1b9c14eb274d891b5ee4b650d))

## [1.3.2](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.3.1...opencode-telegram-bot-v1.3.2) (2026-10-29)


### Bug Fixes

* **node:** install.sh warns when node comes from an fnm multishell path ([#71](https://github.com/tobbieswork/opencode-telegram-bot/issues/71)) ([3524a42](https://github.com/tobbieswork/opencode-telegram-bot/commit/3524a42d5ceadb25e4e05d90c41b94773157435d))

## [1.3.1](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.3.0...opencode-telegram-bot-v1.3.1) (2026-10-29)


### Bug Fixes

* **node:** sửa install.sh của Mac node daemon (REPO_ROOT sai) + hardening ([#69](https://github.com/tobbieswork/opencode-telegram-bot/issues/69)) ([478e478](https://github.com/tobbieswork/opencode-telegram-bot/commit/478e47808d903d73e8fca16fdb634c6fab5c10ca))

## [1.3.0](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.2.5...opencode-telegram-bot-v1.3.0) (2026-10-29)


### Features

* **node:** Mac node — Claude CLI on Mac, task queue over git ([#67](https://github.com/tobbieswork/opencode-telegram-bot/issues/67)) ([dbd7bbd](https://github.com/tobbieswork/opencode-telegram-bot/commit/dbd7bbdcd535944378da52c048cab92c514e088e))

## [1.2.5](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.2.4...opencode-telegram-bot-v1.2.5) (2026-10-29)


### Bug Fixes

* **release:** validate release id is numeric before using it ([#65](https://github.com/tobbieswork/opencode-telegram-bot/issues/65)) ([1db266f](https://github.com/tobbieswork/opencode-telegram-bot/commit/1db266fe4876cef237c7d3f667f5299fbe8d2665))

## [1.2.4](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.2.3...opencode-telegram-bot-v1.2.4) (2026-10-29)


### Bug Fixes

* **release:** normalize step waits for anchor tag before rev-parse ([#63](https://github.com/tobbieswork/opencode-telegram-bot/issues/63)) ([ae8bc9d](https://github.com/tobbieswork/opencode-telegram-bot/commit/ae8bc9de1872b12d5aa31709e256ae58a62d5b9d))

## [1.2.3](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.2.2...opencode-telegram-bot-v1.2.3) (2026-10-29)


### Bug Fixes

* **release:** push trigger no-op as owner PAT, not the creating app ([#61](https://github.com/tobbieswork/opencode-telegram-bot/issues/61)) ([50c3001](https://github.com/tobbieswork/opencode-telegram-bot/commit/50c300122f62ccfa4f9602646f515ce77cbe3af2))

## [1.2.2](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.2.1...opencode-telegram-bot-v1.2.2) (2026-10-29)


### Bug Fixes

* **release:** trigger no-op via PATCH /git/refs/heads/{branch} ([#59](https://github.com/tobbieswork/opencode-telegram-bot/issues/59)) ([055df8b](https://github.com/tobbieswork/opencode-telegram-bot/commit/055df8b998ab7704a27d1bcfe6cd5b7a924d2b70))

## [1.2.1](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.2.0...opencode-telegram-bot-v1.2.1) (2026-10-28)


### Bug Fixes

* **release:** keep anchor tag + API updateRef + clean /status tag ([b7fc9af](https://github.com/tobbieswork/opencode-telegram-bot/commit/b7fc9af1292c416c2cdcb780bfb9c9a74fbefb6b))
* **release:** keep anchor tag + API updateRef + clean /status tag ([c69221b](https://github.com/tobbieswork/opencode-telegram-bot/commit/c69221b3f09a9a08cb78dc0192c5d7bbcbc4533d))
* **release:** monorepo config + normalize tag to v-prefixed ([72ab9a1](https://github.com/tobbieswork/opencode-telegram-bot/commit/72ab9a181eb2c9af9598b79c8ece791be7f00cdd))
* **release:** monorepo config + normalize tag to v-prefixed ([2e9de8e](https://github.com/tobbieswork/opencode-telegram-bot/commit/2e9de8e0a8c0a77a74018407507a38c22e9eb244))
* **release:** push no-op via git instead of git.updateRef ([c22f097](https://github.com/tobbieswork/opencode-telegram-bot/commit/c22f0973dedcc39f2c40650ddee4fcc13692cb9e))
* **release:** single-repo config for clean tag names ([103787f](https://github.com/tobbieswork/opencode-telegram-bot/commit/103787f662a306b3e7720dfb5e6d761834b3fffe))
* **release:** single-repo config format for clean v-prefixed tags ([7785b50](https://github.com/tobbieswork/opencode-telegram-bot/commit/7785b50ffe93141c085169aef226efe830e1744d))
* **release:** trigger no-op via git push ([f96e49d](https://github.com/tobbieswork/opencode-telegram-bot/commit/f96e49d53ca2b876da2949b5119cce7567a3466c))

## [1.2.0](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.1.0...opencode-telegram-bot-v1.2.0) (2026-10-28)


### Features

* "Thêm vào note" button on busy reply (regular + manager) ([27b0e3f](https://github.com/tobbieswork/opencode-telegram-bot/commit/27b0e3f4bb8e46bf85596d98883895349d53b073))
* /context — session snapshot (usage, files touched, last prompt) ([592ae94](https://github.com/tobbieswork/opencode-telegram-bot/commit/592ae94c33adf805623eb81e2bc2eb136778c0cb))
* /help command menu — tappable buttons for every arg-less command ([13ad46f](https://github.com/tobbieswork/opencode-telegram-bot/commit/13ad46f93852c1a7016af3085e8a33eee69ecff1))
* /mode command with inline button picker (build/plan/general/explore) ([f25dc28](https://github.com/tobbieswork/opencode-telegram-bot/commit/f25dc283d56e82854cd30b01a24216e90eee687f))
* /new confirm button + note above new in / menu ([2b46048](https://github.com/tobbieswork/opencode-telegram-bot/commit/2b46048e9fb11509e1a2ff460233065a197089a3))
* /new confirm button + note above new in / menu ([121bead](https://github.com/tobbieswork/opencode-telegram-bot/commit/121bead8d2fa903fcaeefa371f0666dcb0e92b36))
* /note scratchpad command (jot info while agent is busy) ([a72bb48](https://github.com/tobbieswork/opencode-telegram-bot/commit/a72bb483ee14b3c2704573e83bf619ee7ec2da7d))
* /note scratchpad command for jotting info while the agent is busy ([ec6e3b5](https://github.com/tobbieswork/opencode-telegram-bot/commit/ec6e3b5cd782840a147105a1f2d30694ac30efb4))
* /prune worker topics + auto-close finished topics ([be0cb07](https://github.com/tobbieswork/opencode-telegram-bot/commit/be0cb07d4c42fa45a2f9095908e13e25758f6a6e))
* /schedule — run automated prompts on a schedule ([#32](https://github.com/tobbieswork/opencode-telegram-bot/issues/32)) ([947a967](https://github.com/tobbieswork/opencode-telegram-bot/commit/947a967fe86c31cf585561170e7b464bab7445c6))
* /usage — per-session context pressure ([d7f20fc](https://github.com/tobbieswork/opencode-telegram-bot/commit/d7f20fcc59825e1502de043bc27b94a4be5b5227))
* /usage liveness — active-first report, dead collapse, --all ([0bbe034](https://github.com/tobbieswork/opencode-telegram-bot/commit/0bbe0347a6e8446fc2972287b4f86ceb47640d13))
* /usage liveness — active-first report, dead collapse, --all ([77ff07e](https://github.com/tobbieswork/opencode-telegram-bot/commit/77ff07e2f45d47d5f936d7560c6d01c2fbb04f12))
* 🔥 spawn goes through the manager — it crafts the task with full context ([8edeee8](https://github.com/tobbieswork/opencode-telegram-bot/commit/8edeee84a3e44327be9d30ed20c49ac7097fb075))
* 🔥 spawn goes through the manager — it crafts the task with full context ([c3e1b99](https://github.com/tobbieswork/opencode-telegram-bot/commit/c3e1b990fe74ac061cc5c0bf52c299a8cee744cb))
* add "Thêm vào note" button to busy reply ([3710c00](https://github.com/tobbieswork/opencode-telegram-bot/commit/3710c00f47f3abf86738846ff7db6ce47d4276b3))
* add "Thêm vào note" button to manager busy reply ([c7ade80](https://github.com/tobbieswork/opencode-telegram-bot/commit/c7ade8083d53a33899a27ff41f0cdb9f5125cd8a))
* add /usage command for per-session context pressure ([ee84558](https://github.com/tobbieswork/opencode-telegram-bot/commit/ee8455884648292644226845ef79f3cd61c9ae6a))
* answer OpenCode permission prompts from Telegram ([7da3698](https://github.com/tobbieswork/opencode-telegram-bot/commit/7da3698d85c80dea3bdf9f95a1b44985e5f900b4))
* auto-respawn workers that die from context overflow ([683fd0e](https://github.com/tobbieswork/opencode-telegram-bot/commit/683fd0e1205c4d71df705880f6b3a2729ce9eac2))
* auto-respawn workers that die from context overflow ([64405c8](https://github.com/tobbieswork/opencode-telegram-bot/commit/64405c829f2bdd8526c3634652cb956a54d4d9f7))
* **btw:** /btw side-question on a throwaway session ([75c7bec](https://github.com/tobbieswork/opencode-telegram-bot/commit/75c7bec8a12e87bd8c1aa76cf3a315f2ec141d3c))
* **btw:** /btw side-question on throwaway session ([29b2a84](https://github.com/tobbieswork/opencode-telegram-bot/commit/29b2a840d4c2383da38227f32481fa05c303515f))
* button pickers for arg-required commands ([4bbbeee](https://github.com/tobbieswork/opencode-telegram-bot/commit/4bbbeee1a8ef84c076172b747d4bdba65f757774))
* command menu, media captions, and live tool activity line ([ec07dbb](https://github.com/tobbieswork/opencode-telegram-bot/commit/ec07dbbb73482f8929201e8dca5c58867c48f273))
* continue button, reboot self-heal fixes + blog posts 4-5 ([97f6aca](https://github.com/tobbieswork/opencode-telegram-bot/commit/97f6acaae909691e5fd3f17fe65b9d24636302ec))
* group-chat streaming preview via self-editing message ([fec093c](https://github.com/tobbieswork/opencode-telegram-bot/commit/fec093c74103537761fc75b5b0212a360efc568b))
* group-chat streaming preview via self-editing message ([052cd7c](https://github.com/tobbieswork/opencode-telegram-bot/commit/052cd7ca9d390cb84621474ff3ce5a7916aac7c9))
* live streaming drafts (sendMessageDraft, pilot flag) ([a2a8329](https://github.com/tobbieswork/opencode-telegram-bot/commit/a2a83291e7d96c3af9cc322fc20d3e7af988d675))
* live streaming drafts for in-progress replies (pilot flag, default off) ([11e8df9](https://github.com/tobbieswork/opencode-telegram-bot/commit/11e8df9c9ab74e3e97607d8d1d8f60cef24890c6))
* mode picker explains each mode; hide redundant agent commands ([4807d61](https://github.com/tobbieswork/opencode-telegram-bot/commit/4807d6155b1cc7eb3b397a69729d0715d24cfa19))
* nút Chạy tiếp khi session fail ([d0ca925](https://github.com/tobbieswork/opencode-telegram-bot/commit/d0ca92521efeb5c0d76a24873551b07e1c8cdb7b))
* one-tap plan-to-build handoff after a successful plan turn ([6f7a97b](https://github.com/tobbieswork/opencode-telegram-bot/commit/6f7a97b1735697beb1b27d8af6aefaf443d586e3))
* parallel sessions in forum topics, with a Manager agent ([89bc18e](https://github.com/tobbieswork/opencode-telegram-bot/commit/89bc18e4b7737812cd47872e66e06b3a132a4afa))
* parallel sessions in forum topics, with a Manager agent ([0be7b58](https://github.com/tobbieswork/opencode-telegram-bot/commit/0be7b58225950187684c630b0d54bd182ba1f96c))
* persist typing until reply, /variants (default xhigh), full /models, orphan-reply recovery ([0ab9b5e](https://github.com/tobbieswork/opencode-telegram-bot/commit/0ab9b5e4bf4515b89072c28036428ebb7aece61d))
* PR watcher — one line per new PR event (merged/comment/CI/review) ([77c1c56](https://github.com/tobbieswork/opencode-telegram-bot/commit/77c1c56ad753ea580d1111b079bf40aadd342458))
* PR watcher — one Telegram line per new PR event on a watched repo ([67f742b](https://github.com/tobbieswork/opencode-telegram-bot/commit/67f742b55d2ffecd533d5cf0c322abc9f9d90c44))
* reaction spawn trigger 🚀 → 🔥 ([cf47f1c](https://github.com/tobbieswork/opencode-telegram-bot/commit/cf47f1c4484832919983be1bc6d13c5091ed2489))
* reaction spawn trigger 🚀 → 🔥 (user preference) ([d4eaad4](https://github.com/tobbieswork/opencode-telegram-bot/commit/d4eaad4e034d3ce8e21555711fc3d4a141495471))
* **release:** auto-fire synchronize on release PR ([817ee76](https://github.com/tobbieswork/opencode-telegram-bot/commit/817ee76ca24f9103b1face7ddf02ebda022b6252))
* **release:** auto-fire synchronize on the release PR ([48281c5](https://github.com/tobbieswork/opencode-telegram-bot/commit/48281c5739f83069c7f6a66104fd672e1659823f))
* render markdown tables for Telegram (aligned block or list) + format tests ([c40c04e](https://github.com/tobbieswork/opencode-telegram-bot/commit/c40c04e5f70b867b3090bb66aa41d9c8ce85c3b0))
* retroactively close finished worker topics at startup ([f9a57ba](https://github.com/tobbieswork/opencode-telegram-bot/commit/f9a57baef9dec818a4d11a673aec56dc4cc6979b))
* self-heal stale VPN DNS in the Telegram polling loop ([2c45a5a](https://github.com/tobbieswork/opencode-telegram-bot/commit/2c45a5ae393e1c681d0e6003b0b503b65f7a0062))
* self-heal stale VPN DNS in the Telegram polling loop ([133482f](https://github.com/tobbieswork/opencode-telegram-bot/commit/133482f69e2438e66eb83c1cd102fba738af160c))
* send final model replies as native rich Markdown (opt-in) ([d98b6c1](https://github.com/tobbieswork/opencode-telegram-bot/commit/d98b6c163976d1b8c68762463e4f111fc4016fb8))
* send final model replies as native rich Markdown behind OPENCODE_TG_RICH ([fa93cbf](https://github.com/tobbieswork/opencode-telegram-bot/commit/fa93cbf497f060a61723b47fe8461a2390e0d02f))
* show session titles in /use picker buttons ([4f021b3](https://github.com/tobbieswork/opencode-telegram-bot/commit/4f021b307665d2ad47294dfccd9467a1c8793e8b))
* single-source command catalog for menu, /help card and button grid ([e514172](https://github.com/tobbieswork/opencode-telegram-bot/commit/e51417257c08b0aae83374bfca969389ec0c9b15))
* single-source command catalog for menu, /help card and button grid ([c13122c](https://github.com/tobbieswork/opencode-telegram-bot/commit/c13122c4e4590fb7feaf1bf0b51d488f7d73f0a3))
* **status:** show deployed git version in /status ([ce91ad1](https://github.com/tobbieswork/opencode-telegram-bot/commit/ce91ad1e4205a2a972a2e04e2e59df970acd4078))
* telegram reaction UX (🚀 spawn, 👍/👎 worker report, bot body language) ([0a4b37a](https://github.com/tobbieswork/opencode-telegram-bot/commit/0a4b37a1630f98148b65fd6f375aad12d01bff7b))
* telegram reaction UX (🚀 spawn, 👍/👎 worker report, bot body language) ([1f8d4bb](https://github.com/tobbieswork/opencode-telegram-bot/commit/1f8d4bb795a510a44e4bd2eac56aea855fcafd2b))
* Telegram reply handling, clearer errors, language guard, reminders ([0ff49e8](https://github.com/tobbieswork/opencode-telegram-bot/commit/0ff49e8a8b1aa6fd345e4d34b7f9002dacfaa57b))
* Telegram reply handling, clearer errors, language guard, reminders ([63ffd6f](https://github.com/tobbieswork/opencode-telegram-bot/commit/63ffd6f9b79a25ba6d618c4f22d089ff3d04dec1))
* uptime monitor with two-step reboot button ([47c874c](https://github.com/tobbieswork/opencode-telegram-bot/commit/47c874c38738108f7a87e4738504fa450239f5f1))
* uptime monitor with two-step reboot button ([fb261db](https://github.com/tobbieswork/opencode-telegram-bot/commit/fb261dbe42c8839e4aa6d548bdee5dc7c5c53592))


### Bug Fixes

* /note empty hint contained raw HTML tag ([146dc18](https://github.com/tobbieswork/opencode-telegram-bot/commit/146dc186bd2e7ab3d752a937aedcc042ea6ed6ca))
* /note empty hint had raw HTML tag ([4ef0334](https://github.com/tobbieswork/opencode-telegram-bot/commit/4ef03345c673aca4857e77765653fcc32e8b5c45))
* /note timestamps now use local time (GMT+7) instead of UTC ([2264bb7](https://github.com/tobbieswork/opencode-telegram-bot/commit/2264bb7ae1883cc57dcd89656130e0cbeb6b110f))
* /note timestamps use local time instead of UTC ([b1b4c5b](https://github.com/tobbieswork/opencode-telegram-bot/commit/b1b4c5b97c3e0d2c6043ef5eed27a440a8e6e90c))
* /status shows the model the session actually runs on ([8c0d704](https://github.com/tobbieswork/opencode-telegram-bot/commit/8c0d7041e9ac255fb9efd3ad9fb3faa85b4b6a85))
* add ~/.opencode/bin to service PATH so bot can auto-spawn OpenCode after reboot ([12ecbb0](https://github.com/tobbieswork/opencode-telegram-bot/commit/12ecbb0744bdd241e3e98202e3b88316a373cf3b))
* **btw:** render reply with rich GFM ([d73b9f8](https://github.com/tobbieswork/opencode-telegram-bot/commit/d73b9f8a64848e3213ff14df4a6b49753ee32956))
* **btw:** render reply with rich GFM instead of escaped plain text ([8e4f8db](https://github.com/tobbieswork/opencode-telegram-bot/commit/8e4f8db5b54dde2160c038e230ea947bcab97deb))
* **ci:** split typecheck into its own job — matches branch protection ([95af964](https://github.com/tobbieswork/opencode-telegram-bot/commit/95af9642df513b70516a255c3181c1fe581967cc))
* clean up state, session and worktree when a topic is deleted in the UI ([2a01816](https://github.com/tobbieswork/opencode-telegram-bot/commit/2a01816bf6cd887034dd271a7ebaa3dab5f43b53))
* clean up topic orphans + restore Manager busy-block ([bc41af4](https://github.com/tobbieswork/opencode-telegram-bot/commit/bc41af41f16827bc6d661dbcf02d4acf2906bb48))
* complete the command surface — /reboot as text, /agents in menu+help ([5f37e0c](https://github.com/tobbieswork/opencode-telegram-bot/commit/5f37e0c8249d99436f0f24d85413c51f1e67bea0))
* complete the command surface — /reboot as text, /agents in menu+help ([36bc088](https://github.com/tobbieswork/opencode-telegram-bot/commit/36bc088a75434f47d4d13ece23c4d552e1a1b96f))
* fall back to Service.ensure() when discover() returns undefined after reboot ([a8bcf3a](https://github.com/tobbieswork/opencode-telegram-bot/commit/a8bcf3ab85a7d32b8a9f456e34fffc1b0685d3ff))
* guard 🔥 on user's own message — confirm, don't spawn duplicate worker ([4e694da](https://github.com/tobbieswork/opencode-telegram-bot/commit/4e694da7228c99be49546c3ed95fdcbf35d11d20))
* guard 🔥 on user's own message — no duplicate spawn ([03f8e65](https://github.com/tobbieswork/opencode-telegram-bot/commit/03f8e6546b7ef80dfcbf84b89670181e031e18b9))
* harden reminders, usage-cap message and docs (review round 2) ([358b859](https://github.com/tobbieswork/opencode-telegram-bot/commit/358b859d82190ee26d88597d444dc5e40c8ca263))
* harden the multi-session layer (review findings) ([b510d3f](https://github.com/tobbieswork/opencode-telegram-bot/commit/b510d3f7a9f2da403faeb44a73cad3181dcc6a36))
* harden topic-delete purge (concurrency, false positives, restart) — review round 2 ([d1dab2f](https://github.com/tobbieswork/opencode-telegram-bot/commit/d1dab2fbf7cfd6360765436385c0d18fe3958191))
* interrupt manager turns when their topic is purged ([321c0e6](https://github.com/tobbieswork/opencode-telegram-bot/commit/321c0e6d534f302c0d1569d65b23375a387a6a47))
* keep reminder schedule across restarts, one failure classifier, retry language removal ([bcf2738](https://github.com/tobbieswork/opencode-telegram-bot/commit/bcf2738ce3b8daa5e98598b16544fa6348740fc6))
* let OpenCode reach the Manager bridge on its first connect ([c623e50](https://github.com/tobbieswork/opencode-telegram-bot/commit/c623e50e23778f6b1ef64124b9455cea29afa9ce))
* lịch chạy im lặng khi OPENCODE_TG_ALLOW_ANY=1 ([677a0b1](https://github.com/tobbieswork/opencode-telegram-bot/commit/677a0b124ee60cd666cf6c66695106a6bdfacb04))
* mint reboot token inside the timer; expire confirm button ([f05b8fd](https://github.com/tobbieswork/opencode-telegram-bot/commit/f05b8fdf12c71d879f7962e6316ebba7b0597d3c))
* observe topic deletion via send failure, harden purge and busy flag ([8687a1f](https://github.com/tobbieswork/opencode-telegram-bot/commit/8687a1f9f1d0bbcd473945279015d63ae935a004))
* overflow recovery default off, consistent classification, full-history follow-ups ([87eaf17](https://github.com/tobbieswork/opencode-telegram-bot/commit/87eaf17feed238b6a42095b5151caff9c3091188))
* relay out-of-band replies and show typing when the session is busy ([967242e](https://github.com/tobbieswork/opencode-telegram-bot/commit/967242ed28723690578402c1522d16deb800e0e1))
* **release:** add manifest + switch to googleapis action ([513859c](https://github.com/tobbieswork/opencode-telegram-bot/commit/513859c66cb03fc0de5fe53409f118ddd9a095e0))
* **release:** add release-please manifest ([858bc0b](https://github.com/tobbieswork/opencode-telegram-bot/commit/858bc0bbc1efb7e85dc0a9ae42f56f8bc2cc3d64))
* **release:** approve app-created release PR with owner token ([c9889a6](https://github.com/tobbieswork/opencode-telegram-bot/commit/c9889a6ecac1b84d54775a3860f33a25796ea390))
* **release:** approve release PR with owner token before merge ([cf798b6](https://github.com/tobbieswork/opencode-telegram-bot/commit/cf798b61e26496674072b3da2ecc06497b2484a5))
* **release:** check tags via API — runners have no origin remote ([14edb55](https://github.com/tobbieswork/opencode-telegram-bot/commit/14edb55adc0b13f80722459a41081d0b04d0360d))
* **release:** guard bootstrap tag check via API ([e09626d](https://github.com/tobbieswork/opencode-telegram-bot/commit/e09626d6692832d1c84726f2a7112300c35648eb))
* **release:** match release PR author via REST login ([59eea03](https://github.com/tobbieswork/opencode-telegram-bot/commit/59eea0373ec1814ea1629087649169e9af736a17))
* **release:** match release PR author via REST login ([872bad3](https://github.com/tobbieswork/opencode-telegram-bot/commit/872bad3928673fdd3d279beed18279b4a04c29d3))
* **release:** merge release PR via gh --admin instead of github-script ([90a7b6d](https://github.com/tobbieswork/opencode-telegram-bot/commit/90a7b6d283313e21b0df7fef85a0df0d03389db6))
* **release:** unblock app-created release PRs via pull_request_target ([e35b837](https://github.com/tobbieswork/opencode-telegram-bot/commit/e35b8374ac0d5d8a608e6e693e3ce8826c096d69))
* **release:** unblock release PRs (pull_request_target) ([a070412](https://github.com/tobbieswork/opencode-telegram-bot/commit/a070412b8f835d857400f47e07980b1c0cc161df))
* reminder persistence across restarts, single failure classifier ([390b716](https://github.com/tobbieswork/opencode-telegram-bot/commit/390b71626af4bc52fd5e91e741cda6fbda06fe21))
* restart DNS only when the stale VPN DNS is confirmed; IP from env ([eed28e9](https://github.com/tobbieswork/opencode-telegram-bot/commit/eed28e9fba29d4bfe97b3a8c90648adfc8cb5f73))
* restore the "⏳ still working" block for the Manager chat ([c659db1](https://github.com/tobbieswork/opencode-telegram-bot/commit/c659db110f85ec0302cbb0d024d8283510423cf9))
* scheduler — tick no longer clobbers concurrent edits; one run at a time; per-run timeout ([#35](https://github.com/tobbieswork/opencode-telegram-bot/issues/35)) ([00b5a9d](https://github.com/tobbieswork/opencode-telegram-bot/commit/00b5a9dd9e08f6267a38056fa92c50b27842fa93))
* scheduler isAllowed must respect allowAny (silent schedule skip in ALLOW_ANY mode) ([d5d373b](https://github.com/tobbieswork/opencode-telegram-bot/commit/d5d373b7dffdd33d9bb5e2592b96e9cfcb336e00))
* stop duplicate question cards — reminders edit in place ([4d91024](https://github.com/tobbieswork/opencode-telegram-bot/commit/4d91024c0835661c7e1a358dbb3b8ea69b9d6e58))
* stop duplicate question cards — reminders now edit in place ([a48db15](https://github.com/tobbieswork/opencode-telegram-bot/commit/a48db1545fdd6084caf411cc870783c4c144bef9))
* untrack node_modules symlink (bot crash-loop) ([ca5d46e](https://github.com/tobbieswork/opencode-telegram-bot/commit/ca5d46ea2b6e694dd14d8a92f03a9a9baa0a955c))
* untrack node_modules symlink committed by mistake ([d3efdf9](https://github.com/tobbieswork/opencode-telegram-bot/commit/d3efdf9a6f0b862c999577be50522a3b8d4bbaa0))
* **usage:** order-independent newest-assistant scan + fmtTok boundary (prep) ([b351450](https://github.com/tobbieswork/opencode-telegram-bot/commit/b351450deb6d0a50429dab4b0b703014161dbb19))
* **usage:** order-safe newest-step scan, cache.write, REST budget, help indent ([59a0c05](https://github.com/tobbieswork/opencode-telegram-bot/commit/59a0c05ef9d7e5832b724088c77154f66384e4e9))

## [1.1.0](https://github.com/tobbieswork/opencode-telegram-bot/compare/opencode-telegram-bot-v1.0.0...opencode-telegram-bot-v1.1.0) (2026-10-28)


### Features

* "Thêm vào note" button on busy reply (regular + manager) ([27b0e3f](https://github.com/tobbieswork/opencode-telegram-bot/commit/27b0e3f4bb8e46bf85596d98883895349d53b073))
* /context — session snapshot (usage, files touched, last prompt) ([592ae94](https://github.com/tobbieswork/opencode-telegram-bot/commit/592ae94c33adf805623eb81e2bc2eb136778c0cb))
* /help command menu — tappable buttons for every arg-less command ([13ad46f](https://github.com/tobbieswork/opencode-telegram-bot/commit/13ad46f93852c1a7016af3085e8a33eee69ecff1))
* /mode command with inline button picker (build/plan/general/explore) ([f25dc28](https://github.com/tobbieswork/opencode-telegram-bot/commit/f25dc283d56e82854cd30b01a24216e90eee687f))
* /note scratchpad command (jot info while agent is busy) ([a72bb48](https://github.com/tobbieswork/opencode-telegram-bot/commit/a72bb483ee14b3c2704573e83bf619ee7ec2da7d))
* /note scratchpad command for jotting info while the agent is busy ([ec6e3b5](https://github.com/tobbieswork/opencode-telegram-bot/commit/ec6e3b5cd782840a147105a1f2d30694ac30efb4))
* /prune worker topics + auto-close finished topics ([be0cb07](https://github.com/tobbieswork/opencode-telegram-bot/commit/be0cb07d4c42fa45a2f9095908e13e25758f6a6e))
* /schedule — run automated prompts on a schedule ([#32](https://github.com/tobbieswork/opencode-telegram-bot/issues/32)) ([947a967](https://github.com/tobbieswork/opencode-telegram-bot/commit/947a967fe86c31cf585561170e7b464bab7445c6))
* /usage — per-session context pressure ([d7f20fc](https://github.com/tobbieswork/opencode-telegram-bot/commit/d7f20fcc59825e1502de043bc27b94a4be5b5227))
* /usage liveness — active-first report, dead collapse, --all ([0bbe034](https://github.com/tobbieswork/opencode-telegram-bot/commit/0bbe0347a6e8446fc2972287b4f86ceb47640d13))
* /usage liveness — active-first report, dead collapse, --all ([77ff07e](https://github.com/tobbieswork/opencode-telegram-bot/commit/77ff07e2f45d47d5f936d7560c6d01c2fbb04f12))
* 🔥 spawn goes through the manager — it crafts the task with full context ([8edeee8](https://github.com/tobbieswork/opencode-telegram-bot/commit/8edeee84a3e44327be9d30ed20c49ac7097fb075))
* 🔥 spawn goes through the manager — it crafts the task with full context ([c3e1b99](https://github.com/tobbieswork/opencode-telegram-bot/commit/c3e1b990fe74ac061cc5c0bf52c299a8cee744cb))
* add "Thêm vào note" button to busy reply ([3710c00](https://github.com/tobbieswork/opencode-telegram-bot/commit/3710c00f47f3abf86738846ff7db6ce47d4276b3))
* add "Thêm vào note" button to manager busy reply ([c7ade80](https://github.com/tobbieswork/opencode-telegram-bot/commit/c7ade8083d53a33899a27ff41f0cdb9f5125cd8a))
* add /usage command for per-session context pressure ([ee84558](https://github.com/tobbieswork/opencode-telegram-bot/commit/ee8455884648292644226845ef79f3cd61c9ae6a))
* answer OpenCode permission prompts from Telegram ([7da3698](https://github.com/tobbieswork/opencode-telegram-bot/commit/7da3698d85c80dea3bdf9f95a1b44985e5f900b4))
* auto-respawn workers that die from context overflow ([683fd0e](https://github.com/tobbieswork/opencode-telegram-bot/commit/683fd0e1205c4d71df705880f6b3a2729ce9eac2))
* auto-respawn workers that die from context overflow ([64405c8](https://github.com/tobbieswork/opencode-telegram-bot/commit/64405c829f2bdd8526c3634652cb956a54d4d9f7))
* **btw:** /btw side-question on a throwaway session ([75c7bec](https://github.com/tobbieswork/opencode-telegram-bot/commit/75c7bec8a12e87bd8c1aa76cf3a315f2ec141d3c))
* **btw:** /btw side-question on throwaway session ([29b2a84](https://github.com/tobbieswork/opencode-telegram-bot/commit/29b2a840d4c2383da38227f32481fa05c303515f))
* button pickers for arg-required commands ([4bbbeee](https://github.com/tobbieswork/opencode-telegram-bot/commit/4bbbeee1a8ef84c076172b747d4bdba65f757774))
* command menu, media captions, and live tool activity line ([ec07dbb](https://github.com/tobbieswork/opencode-telegram-bot/commit/ec07dbbb73482f8929201e8dca5c58867c48f273))
* continue button, reboot self-heal fixes + blog posts 4-5 ([97f6aca](https://github.com/tobbieswork/opencode-telegram-bot/commit/97f6acaae909691e5fd3f17fe65b9d24636302ec))
* group-chat streaming preview via self-editing message ([fec093c](https://github.com/tobbieswork/opencode-telegram-bot/commit/fec093c74103537761fc75b5b0212a360efc568b))
* group-chat streaming preview via self-editing message ([052cd7c](https://github.com/tobbieswork/opencode-telegram-bot/commit/052cd7ca9d390cb84621474ff3ce5a7916aac7c9))
* live streaming drafts (sendMessageDraft, pilot flag) ([a2a8329](https://github.com/tobbieswork/opencode-telegram-bot/commit/a2a83291e7d96c3af9cc322fc20d3e7af988d675))
* live streaming drafts for in-progress replies (pilot flag, default off) ([11e8df9](https://github.com/tobbieswork/opencode-telegram-bot/commit/11e8df9c9ab74e3e97607d8d1d8f60cef24890c6))
* mode picker explains each mode; hide redundant agent commands ([4807d61](https://github.com/tobbieswork/opencode-telegram-bot/commit/4807d6155b1cc7eb3b397a69729d0715d24cfa19))
* nút Chạy tiếp khi session fail ([d0ca925](https://github.com/tobbieswork/opencode-telegram-bot/commit/d0ca92521efeb5c0d76a24873551b07e1c8cdb7b))
* one-tap plan-to-build handoff after a successful plan turn ([6f7a97b](https://github.com/tobbieswork/opencode-telegram-bot/commit/6f7a97b1735697beb1b27d8af6aefaf443d586e3))
* parallel sessions in forum topics, with a Manager agent ([89bc18e](https://github.com/tobbieswork/opencode-telegram-bot/commit/89bc18e4b7737812cd47872e66e06b3a132a4afa))
* parallel sessions in forum topics, with a Manager agent ([0be7b58](https://github.com/tobbieswork/opencode-telegram-bot/commit/0be7b58225950187684c630b0d54bd182ba1f96c))
* persist typing until reply, /variants (default xhigh), full /models, orphan-reply recovery ([0ab9b5e](https://github.com/tobbieswork/opencode-telegram-bot/commit/0ab9b5e4bf4515b89072c28036428ebb7aece61d))
* PR watcher — one line per new PR event (merged/comment/CI/review) ([77c1c56](https://github.com/tobbieswork/opencode-telegram-bot/commit/77c1c56ad753ea580d1111b079bf40aadd342458))
* PR watcher — one Telegram line per new PR event on a watched repo ([67f742b](https://github.com/tobbieswork/opencode-telegram-bot/commit/67f742b55d2ffecd533d5cf0c322abc9f9d90c44))
* reaction spawn trigger 🚀 → 🔥 ([cf47f1c](https://github.com/tobbieswork/opencode-telegram-bot/commit/cf47f1c4484832919983be1bc6d13c5091ed2489))
* reaction spawn trigger 🚀 → 🔥 (user preference) ([d4eaad4](https://github.com/tobbieswork/opencode-telegram-bot/commit/d4eaad4e034d3ce8e21555711fc3d4a141495471))
* render markdown tables for Telegram (aligned block or list) + format tests ([c40c04e](https://github.com/tobbieswork/opencode-telegram-bot/commit/c40c04e5f70b867b3090bb66aa41d9c8ce85c3b0))
* retroactively close finished worker topics at startup ([f9a57ba](https://github.com/tobbieswork/opencode-telegram-bot/commit/f9a57baef9dec818a4d11a673aec56dc4cc6979b))
* self-heal stale VPN DNS in the Telegram polling loop ([2c45a5a](https://github.com/tobbieswork/opencode-telegram-bot/commit/2c45a5ae393e1c681d0e6003b0b503b65f7a0062))
* self-heal stale VPN DNS in the Telegram polling loop ([133482f](https://github.com/tobbieswork/opencode-telegram-bot/commit/133482f69e2438e66eb83c1cd102fba738af160c))
* send final model replies as native rich Markdown (opt-in) ([d98b6c1](https://github.com/tobbieswork/opencode-telegram-bot/commit/d98b6c163976d1b8c68762463e4f111fc4016fb8))
* send final model replies as native rich Markdown behind OPENCODE_TG_RICH ([fa93cbf](https://github.com/tobbieswork/opencode-telegram-bot/commit/fa93cbf497f060a61723b47fe8461a2390e0d02f))
* show session titles in /use picker buttons ([4f021b3](https://github.com/tobbieswork/opencode-telegram-bot/commit/4f021b307665d2ad47294dfccd9467a1c8793e8b))
* single-source command catalog for menu, /help card and button grid ([e514172](https://github.com/tobbieswork/opencode-telegram-bot/commit/e51417257c08b0aae83374bfca969389ec0c9b15))
* single-source command catalog for menu, /help card and button grid ([c13122c](https://github.com/tobbieswork/opencode-telegram-bot/commit/c13122c4e4590fb7feaf1bf0b51d488f7d73f0a3))
* **status:** show deployed git version in /status ([ce91ad1](https://github.com/tobbieswork/opencode-telegram-bot/commit/ce91ad1e4205a2a972a2e04e2e59df970acd4078))
* telegram reaction UX (🚀 spawn, 👍/👎 worker report, bot body language) ([0a4b37a](https://github.com/tobbieswork/opencode-telegram-bot/commit/0a4b37a1630f98148b65fd6f375aad12d01bff7b))
* telegram reaction UX (🚀 spawn, 👍/👎 worker report, bot body language) ([1f8d4bb](https://github.com/tobbieswork/opencode-telegram-bot/commit/1f8d4bb795a510a44e4bd2eac56aea855fcafd2b))
* Telegram reply handling, clearer errors, language guard, reminders ([0ff49e8](https://github.com/tobbieswork/opencode-telegram-bot/commit/0ff49e8a8b1aa6fd345e4d34b7f9002dacfaa57b))
* Telegram reply handling, clearer errors, language guard, reminders ([63ffd6f](https://github.com/tobbieswork/opencode-telegram-bot/commit/63ffd6f9b79a25ba6d618c4f22d089ff3d04dec1))
* uptime monitor with two-step reboot button ([47c874c](https://github.com/tobbieswork/opencode-telegram-bot/commit/47c874c38738108f7a87e4738504fa450239f5f1))
* uptime monitor with two-step reboot button ([fb261db](https://github.com/tobbieswork/opencode-telegram-bot/commit/fb261dbe42c8839e4aa6d548bdee5dc7c5c53592))


### Bug Fixes

* /note empty hint contained raw HTML tag ([146dc18](https://github.com/tobbieswork/opencode-telegram-bot/commit/146dc186bd2e7ab3d752a937aedcc042ea6ed6ca))
* /note empty hint had raw HTML tag ([4ef0334](https://github.com/tobbieswork/opencode-telegram-bot/commit/4ef03345c673aca4857e77765653fcc32e8b5c45))
* /note timestamps now use local time (GMT+7) instead of UTC ([2264bb7](https://github.com/tobbieswork/opencode-telegram-bot/commit/2264bb7ae1883cc57dcd89656130e0cbeb6b110f))
* /note timestamps use local time instead of UTC ([b1b4c5b](https://github.com/tobbieswork/opencode-telegram-bot/commit/b1b4c5b97c3e0d2c6043ef5eed27a440a8e6e90c))
* /status shows the model the session actually runs on ([8c0d704](https://github.com/tobbieswork/opencode-telegram-bot/commit/8c0d7041e9ac255fb9efd3ad9fb3faa85b4b6a85))
* add ~/.opencode/bin to service PATH so bot can auto-spawn OpenCode after reboot ([12ecbb0](https://github.com/tobbieswork/opencode-telegram-bot/commit/12ecbb0744bdd241e3e98202e3b88316a373cf3b))
* **btw:** render reply with rich GFM ([d73b9f8](https://github.com/tobbieswork/opencode-telegram-bot/commit/d73b9f8a64848e3213ff14df4a6b49753ee32956))
* **btw:** render reply with rich GFM instead of escaped plain text ([8e4f8db](https://github.com/tobbieswork/opencode-telegram-bot/commit/8e4f8db5b54dde2160c038e230ea947bcab97deb))
* **ci:** split typecheck into its own job — matches branch protection ([95af964](https://github.com/tobbieswork/opencode-telegram-bot/commit/95af9642df513b70516a255c3181c1fe581967cc))
* clean up state, session and worktree when a topic is deleted in the UI ([2a01816](https://github.com/tobbieswork/opencode-telegram-bot/commit/2a01816bf6cd887034dd271a7ebaa3dab5f43b53))
* clean up topic orphans + restore Manager busy-block ([bc41af4](https://github.com/tobbieswork/opencode-telegram-bot/commit/bc41af41f16827bc6d661dbcf02d4acf2906bb48))
* complete the command surface — /reboot as text, /agents in menu+help ([5f37e0c](https://github.com/tobbieswork/opencode-telegram-bot/commit/5f37e0c8249d99436f0f24d85413c51f1e67bea0))
* complete the command surface — /reboot as text, /agents in menu+help ([36bc088](https://github.com/tobbieswork/opencode-telegram-bot/commit/36bc088a75434f47d4d13ece23c4d552e1a1b96f))
* fall back to Service.ensure() when discover() returns undefined after reboot ([a8bcf3a](https://github.com/tobbieswork/opencode-telegram-bot/commit/a8bcf3ab85a7d32b8a9f456e34fffc1b0685d3ff))
* guard 🔥 on user's own message — confirm, don't spawn duplicate worker ([4e694da](https://github.com/tobbieswork/opencode-telegram-bot/commit/4e694da7228c99be49546c3ed95fdcbf35d11d20))
* guard 🔥 on user's own message — no duplicate spawn ([03f8e65](https://github.com/tobbieswork/opencode-telegram-bot/commit/03f8e6546b7ef80dfcbf84b89670181e031e18b9))
* harden reminders, usage-cap message and docs (review round 2) ([358b859](https://github.com/tobbieswork/opencode-telegram-bot/commit/358b859d82190ee26d88597d444dc5e40c8ca263))
* harden the multi-session layer (review findings) ([b510d3f](https://github.com/tobbieswork/opencode-telegram-bot/commit/b510d3f7a9f2da403faeb44a73cad3181dcc6a36))
* harden topic-delete purge (concurrency, false positives, restart) — review round 2 ([d1dab2f](https://github.com/tobbieswork/opencode-telegram-bot/commit/d1dab2fbf7cfd6360765436385c0d18fe3958191))
* interrupt manager turns when their topic is purged ([321c0e6](https://github.com/tobbieswork/opencode-telegram-bot/commit/321c0e6d534f302c0d1569d65b23375a387a6a47))
* keep reminder schedule across restarts, one failure classifier, retry language removal ([bcf2738](https://github.com/tobbieswork/opencode-telegram-bot/commit/bcf2738ce3b8daa5e98598b16544fa6348740fc6))
* let OpenCode reach the Manager bridge on its first connect ([c623e50](https://github.com/tobbieswork/opencode-telegram-bot/commit/c623e50e23778f6b1ef64124b9455cea29afa9ce))
* lịch chạy im lặng khi OPENCODE_TG_ALLOW_ANY=1 ([677a0b1](https://github.com/tobbieswork/opencode-telegram-bot/commit/677a0b124ee60cd666cf6c66695106a6bdfacb04))
* mint reboot token inside the timer; expire confirm button ([f05b8fd](https://github.com/tobbieswork/opencode-telegram-bot/commit/f05b8fdf12c71d879f7962e6316ebba7b0597d3c))
* observe topic deletion via send failure, harden purge and busy flag ([8687a1f](https://github.com/tobbieswork/opencode-telegram-bot/commit/8687a1f9f1d0bbcd473945279015d63ae935a004))
* overflow recovery default off, consistent classification, full-history follow-ups ([87eaf17](https://github.com/tobbieswork/opencode-telegram-bot/commit/87eaf17feed238b6a42095b5151caff9c3091188))
* relay out-of-band replies and show typing when the session is busy ([967242e](https://github.com/tobbieswork/opencode-telegram-bot/commit/967242ed28723690578402c1522d16deb800e0e1))
* **release:** add manifest + switch to googleapis action ([513859c](https://github.com/tobbieswork/opencode-telegram-bot/commit/513859c66cb03fc0de5fe53409f118ddd9a095e0))
* **release:** add release-please manifest ([858bc0b](https://github.com/tobbieswork/opencode-telegram-bot/commit/858bc0bbc1efb7e85dc0a9ae42f56f8bc2cc3d64))
* **release:** approve app-created release PR with owner token ([c9889a6](https://github.com/tobbieswork/opencode-telegram-bot/commit/c9889a6ecac1b84d54775a3860f33a25796ea390))
* **release:** approve release PR with owner token before merge ([cf798b6](https://github.com/tobbieswork/opencode-telegram-bot/commit/cf798b61e26496674072b3da2ecc06497b2484a5))
* **release:** check tags via API — runners have no origin remote ([14edb55](https://github.com/tobbieswork/opencode-telegram-bot/commit/14edb55adc0b13f80722459a41081d0b04d0360d))
* **release:** guard bootstrap tag check via API ([e09626d](https://github.com/tobbieswork/opencode-telegram-bot/commit/e09626d6692832d1c84726f2a7112300c35648eb))
* **release:** unblock app-created release PRs via pull_request_target ([e35b837](https://github.com/tobbieswork/opencode-telegram-bot/commit/e35b8374ac0d5d8a608e6e693e3ce8826c096d69))
* **release:** unblock release PRs (pull_request_target) ([a070412](https://github.com/tobbieswork/opencode-telegram-bot/commit/a070412b8f835d857400f47e07980b1c0cc161df))
* reminder persistence across restarts, single failure classifier ([390b716](https://github.com/tobbieswork/opencode-telegram-bot/commit/390b71626af4bc52fd5e91e741cda6fbda06fe21))
* restart DNS only when the stale VPN DNS is confirmed; IP from env ([eed28e9](https://github.com/tobbieswork/opencode-telegram-bot/commit/eed28e9fba29d4bfe97b3a8c90648adfc8cb5f73))
* restore the "⏳ still working" block for the Manager chat ([c659db1](https://github.com/tobbieswork/opencode-telegram-bot/commit/c659db110f85ec0302cbb0d024d8283510423cf9))
* scheduler — tick no longer clobbers concurrent edits; one run at a time; per-run timeout ([#35](https://github.com/tobbieswork/opencode-telegram-bot/issues/35)) ([00b5a9d](https://github.com/tobbieswork/opencode-telegram-bot/commit/00b5a9dd9e08f6267a38056fa92c50b27842fa93))
* scheduler isAllowed must respect allowAny (silent schedule skip in ALLOW_ANY mode) ([d5d373b](https://github.com/tobbieswork/opencode-telegram-bot/commit/d5d373b7dffdd33d9bb5e2592b96e9cfcb336e00))
* stop duplicate question cards — reminders edit in place ([4d91024](https://github.com/tobbieswork/opencode-telegram-bot/commit/4d91024c0835661c7e1a358dbb3b8ea69b9d6e58))
* stop duplicate question cards — reminders now edit in place ([a48db15](https://github.com/tobbieswork/opencode-telegram-bot/commit/a48db1545fdd6084caf411cc870783c4c144bef9))
* untrack node_modules symlink (bot crash-loop) ([ca5d46e](https://github.com/tobbieswork/opencode-telegram-bot/commit/ca5d46ea2b6e694dd14d8a92f03a9a9baa0a955c))
* untrack node_modules symlink committed by mistake ([d3efdf9](https://github.com/tobbieswork/opencode-telegram-bot/commit/d3efdf9a6f0b862c999577be50522a3b8d4bbaa0))
* **usage:** order-independent newest-assistant scan + fmtTok boundary (prep) ([b351450](https://github.com/tobbieswork/opencode-telegram-bot/commit/b351450deb6d0a50429dab4b0b703014161dbb19))
* **usage:** order-safe newest-step scan, cache.write, REST budget, help indent ([59a0c05](https://github.com/tobbieswork/opencode-telegram-bot/commit/59a0c05ef9d7e5832b724088c77154f66384e4e9))
