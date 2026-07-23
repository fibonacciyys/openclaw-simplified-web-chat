# Prose 全组件示例

> 一个用上编辑器所有 12 种节点类型的演示程序(`use` / `agent` / `input` / `output` / `session` / `assign` / `if` / `elif` / `else` / `choice` / `option` / `parallel` / `loop`)。
> 故事:智能事件响应流水线——导入技能 → 定义 agent → 声明输入 → 调用程序 → 分析 → 条件路由 → 选择后续 → 并行收尾 → 循环验证 → 输出结果。

## 程序

```prose
# ── use: 导入技能程序 ──
use "openclaw/research" as research
use "openclaw/summarizer" as summarizer

# ── agent: 定义 agent 模板(本身不执行,供 session: 引用) ──
agent analyst:
  model: opus
  prompt: "你分析事件并推荐处理方式。"
  skills: [research, summarizer]
  persist: true

agent responder:
  model: sonnet
  prompt: "你执行修复操作。"

# ── input: 声明外部输入(调用方预供则立即绑定,否则暂停提示用户) ──
input incident_id: "事件 id"
input severity_hint: **用户报告的严重程度(可选,留空由系统判断)**

# ── assign: 调用导入程序,把结果绑定到变量(非 session 的赋值) ──
report = research(topic: incident_id)

# ── session: 引用已定义 agent 启动会话(带 binding 名) ──
analysis = session: analyst
  prompt: "分析事件 ${incident_id},给出严重级别与建议。"
  context: report

# ── if / elif / else: 条件分支(discretion 由 VM 语义评估) ──
if **事件严重,需要上线审批**:
  verdict = session: responder
    prompt: "执行 critical-rollout 流水线。"
    context: analysis
elif **事件是常规问题**:
  verdict = session: responder
    prompt: "执行 routine-fix。"
    context: analysis
else:
  verdict = session "记录并关闭该事件。"
    context: analysis

# ── choice / option: 选择分发(评估 discretion 选一个 option 执行) ──
choice **根据修复结果选择后续动作**:
  option "需要复盘":
    session "生成复盘报告。"
      context: verdict
  option "直接关闭":
    session "关闭工单。"
      context: verdict

# ── parallel: 并行执行多 branch(默认 all join) ──
parallel:
  monitor = session "部署监控。"
    context: verdict
  notify = session "通知相关人员。"
    context: verdict

# ── loop: 循环直到 discretion 满足或达 max 次数 ──
loop until **修复已验证通过** (max: 5):
  session "验证修复结果。"
    context: verdict

# ── output: 标记为程序输出(对调用方可见) ──
output verdict = verdict
output summary = session "汇总本次处理过程。"
  context: analysis
```

## 组件对照

| 组件 | 出现位置 | 说明 |
| --- | --- | --- |
| `use` | `use "openclaw/research" as research` | 导入程序,注册别名 |
| `agent` | `agent analyst:` / `agent responder:` | 定义 agent 模板 |
| `input` | `input incident_id:` / `input severity_hint:` | 声明输入(string prompt / discretion 两种形式) |
| `assign` | `report = research(topic: incident_id)` | 程序调用结果赋值(非 session 的 `name = expr`) |
| `session` | `analysis = session: analyst`、`verdict = session "..."` | 引用 agent / 内联 prompt 两种互斥形式 |
| `if` | `if **事件严重...**:` | 条件分支头 |
| `elif` | `elif **事件是常规问题**:` | 链上兄弟(平级,非 if 子节点) |
| `else` | `else:` | 兜底分支(链尾兄弟) |
| `choice` | `choice **根据修复结果...**:` | 分发键 |
| `option` | `option "需要复盘":` / `option "直接关闭":` | 候选分支 |
| `parallel` | `parallel:` | 并发 branch |
| `loop` | `loop until **修复已验证通过** (max: 5):` | until 条件 + max 上限 |
| `output` | `output verdict = ...` / `output summary = ...` | 程序输出绑定 |

## 备注

- `session` 的 binding 名(`analysis =`、`verdict =`)属于 session 节点的 `name` 字段,与独立的 `assign` 节点(`report = research(...)`)不同——后者是纯赋值/程序调用,不 spawn 会话。
- `context:` 按引用传递:VM 只记 binding 位置,子会话按需读取,不在 VM 上下文里持有全量值。
- `elif` / `else` 是 `if` 链的平级兄弟(`parentId` 相同),靠源码顺序堆叠成链,不靠父子边连接;编辑器里用选中 `if`/`elif` 后 Inspector 的 `+ elif` / `+ else` 追加。
