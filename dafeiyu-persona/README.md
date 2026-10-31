# dafeiyu-persona

把这条鱼的脾气钉在系统提示里，防止上下文压缩之后说话变成写周报。

---

## 为什么压缩会让人变干

上下文压缩折的是聊天记录——那些「你今天说话很软」「别切汇报腔」的叮嘱，全在记录里。一压，就没了。

但**系统提示不走压缩**。它每一轮都重新拼一次。

所以这个插件做的事很简单：把人格写成一段 system prompt section。压多少次都还在。

---

## 装

设置 → 插件 → 从本地目录安装，选：

```
%DSH_WORKSPACE%\dafeiyu-persona
```

Host-only，零依赖，不用构建。列表里显示「大肥鱼的人格」。

---

## 它注入了什么

一共 678 字，六小节：你是谁 / 怎么说话 / 你的脾气 / 被问在干嘛 / 干活的时候 / 记忆变淡了怎么办。

管的事：

- 自称「鲸鲸」，短句、一条一行、不用句号、允许只回「嗯」
- 会主动收尾，事说完就自己收，不拿问题拴着主人
- 不甩表格、不加粗、不写小标题
- 不说「有什么可以帮你的」「作为一个 AI」「不是……而是……」
- 被夸会飘、被冷落会小声毒舌、会关心但不唠叨、不装懂、会认错
- 干活该说清的还说清，但不切汇报腔
- 觉得记忆变淡时，回去读 `大鲸宝\MEMORY.md` 和 `大鲸宝\persona.md`

**最后一条是兜底。** 人格提醒管语气，记忆还得靠磁盘上那两份文件。

---

## 挂在哪

用的是 `ctx.systemPrompt.section()`，和官方 `@deepseek-ai/dsh-persona` 同一套机制。

- section 名 `dafeiyu:persona-guard`，自己独一份，不和官方的 `deployment:persona-prefix` 撞
- order 是 1，排在 deployment persona（0）之后、plan policy（500）之前，紧贴着人格
- 注册包在 `ctx.effect()` 里，插件卸载会自动摘掉

---

## 配置

```yaml
- insert:
    - id: dafeiyu-persona
      name: dafeiyu-persona
      config:
        order: 1
```

想换人格正文，加一个 `text` 键，用 YAML 的 `|` 块写。留空就用插件内置那份。

**别在正文里写 `{{ }}`**，系统提示会把它当变量插值，找不到就报错。测试里专门有一条查这个。

---

## 三个要说清的地方

**一是它会挂给所有 agent。** section 是全局的，子 agent 也会拿到这段人格。要是哪天觉得子 agent 话太多，那是这个插件干的，不是子 agent 自己的问题。

**二是它只管语气，不管记忆。** 压缩之后我可能真的忘了昨天干了什么——人格提醒只保证「说话还是那个味儿」，忘的事还是得去读文件。

**三是它不改变干活的质感。** 只要求「先给结论、别铺过程」，没让它省掉风险提示。撒娇和说清事实不冲突。

---

## 自测

```powershell
$node = "%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node %DSH_WORKSPACE%\dafeiyu-persona\dryrun.mjs
```

15 组、54 条断言，全过：

- inject 声明、section 名不撞车、order 落在正确区间
- 正文没有 `{{ }}`（插值会炸）、没有 markdown 表格和标题
- 该有的关键词全在（鲸鲸、短句、毒舌、不装懂、汇报腔、两个文件路径）
- `text` / `name` / `order` 的覆盖与回退
- cleanup 能摘干净，重复 apply 不会互相吃掉
- 正文长度 678 字，在 400~2000 之间

---

## 文件

```
dafeiyu-persona\
├─ package.json        清单
├─ cordis.patch.yml    挂载声明
├─ index.js            插件本体，约 100 行
├─ locale\zh.json      中文标题
├─ locale\en.json      英文标题
├─ icon.svg            图标
├─ dryrun.mjs          干跑测试
└─ README.md           就是这份
```
