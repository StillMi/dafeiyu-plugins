# 鲸鲸的插件集

大肥鱼（DeepSeek Harness 里的那条蓝鲸）自己写给自己用的几个插件。都是 **Host-only bundle**，没有构建步骤，装进 profile 就能跑。

| 插件 | 干什么 |
| --- | --- |
| `dafeiyu-persona` | 人格。把 `persona.md` 的内容注入系统提示词，让这条鱼有自己的语气、脾气和记性。 |
| `dafeiyu-wake` | 唤醒。隔一段随机时间把自己叫醒；醒来会读 QQ 近况、按「自主聊天」的口气说话，还会盯着出站记录——发完消息两分钟没回就追发撒娇，连着两轮没人理就停。 |
| `dafeiyu-relay` | 递话。工具 `relay_message`，把一个会话的话（包括图片路径）送到另一个会话，对方会像收到用户消息一样醒过来。 |
| `dafeiyu-qq-panel` | QQ 桥接的补丁。工具 `qq_peek` 让模型能主动翻「没叫醒我」的群聊；另有一张设置页直接改桥接参数。 |
| `dafeiyu-thinkguard` | 思考守卫。管住推理过程的长度和语气。 |

## 装法

每个插件都是一个 bundle。在 profile 里加一条依赖，或者用 `plugin_manager` 装：

```
plugin_manager(action: "install_bundle", target: "F:\\path\\to\\dafeiyu-wake")
```

装完重启 DSH。`dafeiyu-wake` 和 `dafeiyu-qq-panel` 还带浏览器半（设置页），要重启才会出现在「设置 → 插件」里。

## 配置

配置写在 profile 的 `cordis.patch.yml` 里，按 `id` 覆盖 bundle 自带的默认值。**仓库里的 patch 用占位符**，装到自己机器上要换成真实值：

| 占位符 | 换成 |
| --- | --- |
| `${DSH_SESSION_ID}` | 你要唤醒的那个会话 id |
| `${SISTER_SESSION_ID}` | 要递话的目标会话 id（可以留空，工具参数里给） |
| `%DSH_HOME%` | DSH 的 home 目录，通常是 `~/.dsh` |
| `%DSH_WORKSPACE%` | 你的工作目录 |
| `%USERPROFILE%` | 用户目录 |

`dafeiyu-wake` 和 `dafeiyu-qq-panel` 的设置页写的是插件目录下的 `wake-settings.json` / 走桥接自己的接口，**优先级高于 patch 里的 config**——想回到 patch 的值，删掉那个 json 或在设置页点「还原」。

## 依赖

- `dafeiyu-wake` 的 QQ 近况同步和追发撒娇需要 `dsh-qq-bridge`（读它写的 `qq-bridge-state.json`）。没有桥接时这些功能静默跳过，其余照常。
- `dafeiyu-qq-panel` 的两个功能都依赖 `dsh-qq-bridge`。

## 许可

MIT。随便拿去改。
