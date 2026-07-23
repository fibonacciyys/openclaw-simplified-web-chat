# Prose 组件说明书

> 本文档说明 web-chat Prose 可视化编辑器支持的各类节点(语句 / 控制流)的作用、语法与编辑器字段。
> 语法来源:`extensions/open-prose/skills/prose/prose.md`(执行语义)与 `prose-types.ts`(编辑器数据模型)。

## 概述

OpenProse 是一种**树形 / 块状程序**,采用类似 Python 的 INDENT/DEDENT 缩进结构。整个程序是一个**森林(forest)**:

- 每个**根级 statement** 各自是一棵子树的根(`parentId = null`),根级节点之间靠源码顺序顺序执行,**没有父子边**;
- 只有**容器节点**(if / loop / parallel / choice 等)到其 `body` / `branch` / `option` 子节点这层父子包含关系才画连线。

节点分两类:

| 类别 | 节点类型 | 是否含子节点 |
| --- | --- | --- |
| 叶子语句 | `use` / `agent` / `input` / `output` / `session` / `assign` | 否 |
| 容器组(控制流) | `if` / `elif` / `else` / `choice` / `option` / `parallel` / `loop` | 是 |

容器节点通过 `parentId`(指向所属组)+ `slot`(`"body"` / `"branch"` / `"option"`)+ `order`(在 slot 内的位置)表达包含与顺序。注意:`elif` / `else` 是 `if` 链的**平级兄弟**,不是 `if` 的子节点——它们靠源码顺序堆叠形成链,不靠父子边连接。

---

## 叶子语句

### `use` —— 导入程序

导入一个外部 `.prose` 程序(来自 URL 或 `p.prose.md` 注册表),注册到 Import Registry,供后续调用。

```prose
use "alice/research"          # handle/slug 注册表简写
use "https://example.com/p.prose" as research   # 直链 + 别名
```

| 编辑器字段 | 说明 |
| --- | --- |
| source | handle/slug 或 URL |
| as alias(可选) | 引用别名 |

导入路径解析:`http(s)://` 直链;含 `/` 但无协议 → `https://p.prose.md/{path}`;否则当本地文件。

### `agent` —— 定义 agent 模板

声明一个 agent 模板(模型、系统 prompt、技能、持久化等),供 `session: <name>` 引用复用。本身**不执行**,只是注册。

```prose
agent researcher:
  model: opus
  prompt: "You are a research expert"
  skills: [research, summarizer]
  persist: true
```

| 编辑器字段 | 说明 |
| --- | --- |
| name | agent 名(被 `session:` 引用) |
| model | `sonnet` / `opus` / `haiku` 或网关目录中的真实模型 |
| prompt(系统) | 系统 prompt |
| skills(逗号分隔) | 要绑定的技能 id(须先 `use`) |
| persist | `true`(执行作用域)/ `project` / `user` / 路径 |

持久化作用域:`true` 随 run 结束销毁;`project` 跨 run 存活于项目;`user` 跨项目存活于用户目录。

### `input` —— 声明输入

声明一个来自外部的值。可出现在程序任意位置(顶层或执行中途)。值由调用方预供时立即绑定;否则**暂停执行**,提示用户输入。

```prose
input topic: "The subject to research"     # 字符串 prompt(原样展示)
input next_step: **What should we do next?**  # discretion(VM 智能呈现)
```

| 编辑器字段 | 说明 |
| --- | --- |
| name | 绑定名 |
| 形式(二选一) | string prompt / discretion `**...**` |
| prompt / discretion text | 提示文本 |

discretion 形式(`**...**`)允许 VM 根据上下文智能呈现;字符串 prompt 原样展示。

### `output` —— 输出绑定

把一个值标记为程序的输出(对调用方可见)。类似 `let`,同时注册为程序输出。

```prose
output findings = session "Synthesize research"
  context: raw
```

| 编辑器字段 | 说明 |
| --- | --- |
| name | 输出名 |
| expression | 要输出的表达式 |

### `session` —— 启动会话

触发一次真实的 subagent 会话(通过 Task 工具 spawn)。两种**互斥**形式:

```prose
session: researcher                  # 引用已定义 agent(复用其全套配置)
verdict = session: analyst           # 带绑定名
session "分析该事件"                # 内联 prompt(默认配置)
verdict = session "分析该事件"
```

| 编辑器字段 | 说明 |
| --- | --- |
| binding name(可选) | `name = session ...` |
| 形式(二选一 radio) | `session: <agent>` / `session "<prompt>"` |
| prompt override(可选) | `prompt:` 覆盖本次会话的 prompt |
| model override(可选) | `model:` 覆盖本次会话的 model |

属性优先级:会话级 `model:` 覆盖 agent `model:`;会话级 `prompt:` **替换**(非追加)agent `prompt:`。

### `assign` —— 赋值绑定

把一个表达式的值绑定到变量名。用于保存中间结果供后续会话引用。

```prose
result = session "Compute something"
```

| 编辑器字段 | 说明 |
| --- | --- |
| name | 绑定名 |
| expression | 表达式 |

---

## 控制流(容器组)

### `if` / `elif` / `else` —— 条件分支

按顺序评估 discretion 条件,执行首个匹配分支。`**...**` 条件由 VM **语义评估**(非确定性表达式)。

```prose
if **has security issues**:
  session "Fix security"
elif **has performance issues**:
  session "Optimize"
else:
  session "Approve"
```

| 编辑器字段 | 说明 |
| --- | --- |
| discretion(`if` / `elif`) | `**...**` 条件文本 |
| body(子节点) | then / elif / else 分支体 |

编辑器:`if` / `elif` 的 Inspector 提供 `+ elif` / `+ else`(在链尾追加)、"Add to body"往分支体加子语句。`elif` / `else` 是 `if` 的平级兄弟,各自独立子树。

### `choice` / `option` —— 选择分发

评估 discretion 分发键,选择最合适的 `option` 执行其 body。

```prose
choice **the severity level**:
  option "Critical":
    session "Escalate immediately"
  option "Minor":
    session "Log for later"
```

| 编辑器字段 | 说明 |
| --- | --- |
| `choice` discretion | 分发键 |
| `option` label | 选项标签字符串 |
| body(子节点) | 选项分支体 |

编辑器:`choice` 的 Inspector 提供 `+ option`;`option` 的 body 用 "Add to body"。

### `parallel` —— 并行分支

并发执行多个 branch,按 join 策略汇合、按 on-fail 策略处理失败。

```prose
parallel:
  a = session "Task A"
  b = session "Task B"
```

| 编辑器字段 | 说明 |
| --- | --- |
| join | `all`(全等,默认)/ `first`(首个完成)/ `any`(首个成功) |
| on-fail | `fail-fast`(默认)/ `continue` / `ignore` |
| count(仅 `any`) | 等待 N 个成功 |

编辑器:`parallel` 的子节点用 `slot="branch"`,Inspector 提供 "Add branch"。

### `loop` —— 循环

按 discretion 条件(`until` / `while`)迭代,直到条件满足或达 `max` 次数。

```prose
loop until **the code is bug-free** (max: 10):
  session "Find and fix bugs"
```

| 编辑器字段 | 说明 |
| --- | --- |
| loopKind | `until`(条件满足退出)/ `while`(条件不满足退出) |
| discretion | 终止条件 `**...**` |
| max(可选) | 最大迭代次数 |

编辑器:`loop` 的子节点用 `slot="body"`,Inspector 提供 "Add to body"。

---

## 编辑器操作速查

| 操作 | 方式 |
| --- | --- |
| 添加根级节点 | 顶部工具栏 `+ use` / `+ agent` / `+ input` / `+ session` / `+ assign` / `+ output` / `+ if` / `+ choice` / `+ parallel` / `+ loop` |
| 给容器加子节点 | 选中容器节点 → Inspector 的 "Add to body" / "Add branch" / `+ option` |
| 链式 elif/else | 选中 `if` / `elif` → Inspector 的 `+ elif` / `+ else` |
| 中间插入同级节点 | 选中节点 → Inspector 顶部 "Insert after (sibling)" 的 `+ input` / `+ output` / `+ session` / `+ assign` |
| 删除节点 | 选中节点 → `Delete` 键,或 Inspector 顶部 `Delete` 按钮 |
| 保存程序 | Run 面板 `Save` 按钮,写入 workspace 的 `prose/` 子目录(不运行;需已连接 workspace) |
| 运行程序 | Run 面板 `Run in chat`(写盘 + 发 `/prose run`)或 `Continue`(复用会话续跑) |

---

## 数据流与状态

- **变量传递**:`session` / `assign` / `output` 的绑定值按**引用**传递(VM 只记 binding 位置,不持全量值),后续会话通过 `context:` 引用。
- **discretion(`**...**`)**:由 VM 语义评估,考虑上下文、保守判断、检测进展。
- **执行状态**:运行态存于 `.prose/runs/<id>/`(`state.md` 记录逐块状态,`program.prose` 是程序副本,`bindings/` 存绑定值)。
