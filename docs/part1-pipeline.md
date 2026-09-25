# Part 1 · 全球化礼物资产的自动化生产 Pipeline

> 目标：下月初为 **50 个文化大区** 上线专属礼物资产，用 AI 管线替代传统外包流程。
> 设计原则：**确定性优先、成本可计量、失败可止损、风险可拦截**。

---

## 0. 先算账：决定架构的不是技术，是成本结构

50 个大区 × 每个大区若干礼物，如果"每个资产都从零生成"，成本是线性甚至超线性增长（重试会放大）。
因此架构的第一性原理是 **把 50 份的差异拆成「可枚举的差异」与「可共享的底座」**：

| 层级 | 差异度 | 生产策略 | 数量级 |
| --- | --- | --- | --- |
| 几何骨架（造型/结构/动画） | 低：同一个礼物品类应保持一致识别度 | 人工定稿 **K 个骨架（约 6–8）** + 模型做局部变体 | 8 |
| 纹样/配色/材质 | 高：这是文化差异的主要载体 | 模型批量生成 + 合规审查 | 50 × N |
| 文案/命名/语义 | 高 | LLM 生成 + 母语审校 | 50 × N |

**结论：几何只做 8 次，纹样做 50 次。** 单位资产成本从"一次全量生成"降到"一次贴图生成 + 一次审查"，
这是本方案相对"每个大区全部端到端生成"最核心的 ROI 差异。

同时明确一条边界：**能用规则/检索判定绝不用模型判定，能一次判定绝不用打分**。
面数、UV、贴图尺寸、命名规范 → 脚本；禁忌符号清单命中 → 检索 + 多模态审查双保险；
只有"美学与品牌一致性"这类无法穷举的才交给模型打分，且只做抽检。

---

## 1. 架构设计

### 1.1 全局流程图

```
                    ┌─────────────── 一次性投入层（Week 1） ───────────────┐
  文化研究资料 ──►  [A0] Culture-Spec Agent ──► culture_spec.json（50 份）
                             │                        │
                             │                        ▼
                             │               ★ 人工审核卡点（唯一必过人审）
                             └────────────► 允许/禁止清单 + 纹样白名单
                                                       │
                    ┌─────────────── 规模化生产层 ──────────────────────┐
                                                       ▼
                                        [A1] Concept & Form Agent
                                    （造型描述 / 纹样意图 / 配色约束）
                                                       │  design_intent.json
                        ┌──────────────────────────────┴──────────────────┐
                        ▼                                                 ▼
            [A2] Material & Texture Agent                      [A4] Geometry Validator
            （albedo / roughness / emissive）                  （拓扑·面数·UV·LOD·动画锚点）
                        │ texture_set                                     │ geometry_report
                        └──────────────────┬──────────────────────────────┘
                                           ▼
                              [A3] Cultural Compliance Agent（VLM + 规则双通道）
                                           │ verdict: PASS / WARN / BLOCK
                    ┌──────────────────────┼─────────────────────┐
                    │ BLOCK                │ WARN                │ PASS
                    ▼                      ▼                     ▼
          硬拦截：改写约束重生成     人工抽检队列（5%）   [A5] Visual QA Agent
          （禁止同 prompt 重试）                        （多光照/多背景/48px 缩略图可读性）
                                                                  │ score
                                                    ┌─────────────┴─────────────┐
                                              score < τ                score ≥ τ
                                                    ▼                          ▼
                                          带 diagnosis 回灌 A1/A2        [A6] Packaging Agent
                                          （重试计数 +1）                （glb / 特效配置 / 元数据 / AB 分桶）

                    全程由 Orchestrator 托管：状态机 + 重试账本 + 成本账本 + 断路器
```

### 1.2 核心 Agent 契约（输入 / 输出 / 拦截）

| Agent | 输入 | 输出（产物） | 拦截机制 |
| --- | --- | --- | --- |
| **A0 文化语义解析** | 大区研究资料、历史礼物数据、法务红线库 | `culture_spec.json`：`forbidden_symbols` / `sensitive_colors` / `allowed_motifs[]` / `color_palette` / `naming_rules` / `festival_refs` | **人工审核卡点**：50 份 spec 由区域运营一次性确认，之后全程自动化。spec 字段缺失 → 该大区标记 `SPEC_LOW_CONFIDENCE` |
| **A1 造型与概念生成** | `culture_spec` + `skeleton_library`(8 个已定稿骨架) + 品牌风格指南 | `design_intent.json`：骨架 ID、纹样意图（必须引用 `motif_id`）、配色、材质意图、动效意图 | 引用校验：纹样必须来自 `allowed_motifs`，引用不存在的 motif → 直接判为幻觉，BLOCK 并要求重生成 |
| **A2 材质贴图生成** | `design_intent` + 骨架 UV | `texture_set`：albedo / roughness / emissive（尺寸按平台红线） | 规则校验：尺寸、tileable、alpha 通道、色域；不通过 → 重生成（最多 2 次） |
| **A3 文化合规审查** | `texture_set` + 渲染图 + `culture_spec` | `verdict`：`PASS / WARN / BLOCK` + `violations[]`（含证据区域 bbox 与命中的 spec 条目 ID） | **双通道**：① 规则通道（符号检索/色彩距离/文字 OCR 命中禁忌库）② VLM 通道（语义审查）。任一通道 BLOCK → 硬拦截。两通道不一致 → 自动升为人工（不放行） |
| **A4 结构校验** | glb/mesh | `geometry_report`：面数、拓扑、自穿插、UV 重叠、骨骼与动画锚点、碰撞体、LOD、drawcall 预估 | 平台性能红线拦截（面数/贴图/包体）。属于**确定性检查，脚本执行，不消耗模型预算** |
| **A5 视觉一致性评分** | 多光照/多背景渲染图 + 48px 缩略图 | `score`(1–5) + `issues[]` | 阈值拦截；礼物资产额外做 **小尺寸可辨识度** 检查（直播间里礼物图标通常只有几十像素） |
| **A6 打包交付** | 通过件全量产物 | glb + 特效配置 + 多语言元数据 + AB 实验分桶 + 版本号 | 出包前校验：manifest 完整性、命名规范、尺寸红线 |

### 1.3 质量审查的拦截机制（分级，而非一刀切）

| 等级 | 触发条件 | 系统动作 | 商业含义 |
| --- | --- | --- | --- |
| **BLOCK（硬红线）** | 宗教违规符号、禁忌手势/动物/数字、国旗与领土表述敏感、仇恨与歧视意象 | **立即丢弃产物**，禁止用同一 prompt 重试；必须改写 `design_intent`（换 motif / 抽象化 / 降具象度）后重生成；连续 2 次 BLOCK → 该资产 ESCALATE 人工 | 文化风险是**不可量化损失**，优先级高于产量与成本 |
| **RETRY（可自动修复）** | 面数超标、UV 重叠、自穿插、贴图尺寸/格式错误、JSON 格式错误 | 带 `diagnosis` 回灌对应 Agent，重试计数 +1，上限 2 次 | 用确定性修复消化掉大部分失败 |
| **WARN（可放行抽检）** | 风格轻微偏离、配色饱和度偏高、美学分在阈值边缘 | 放行，但进入人工抽检队列（默认 5% 抽样，WARN 密度高的大区提高到 20%） | 用有限人力覆盖长尾 |
| **PASS** | 全通道通过 | 进入 A5 → A6 | — |

三条关键设计：

1. **拦截前置**：A0 把禁忌写进 `culture_spec`，A1 只允许引用白名单 motif —— 让违规在**生成前**就被约束掉，
   而不是生成后再筛。生成后审查（A3）是保险，不是主力（生成后审查的返工成本远高于前置约束）。
2. **双通道不一致即升级**：规则说安全、VLM 说可疑（或反之）时不取"多数通过"，一律升人工。
   宁可多一次人审，也不放过一个疑似。
3. **50 份 spec 一次性人审**：全流程只有这一个必过人审的卡点，把人的注意力花在**杠杆最高**的地方。

---

## 2. 上下文工程：生成 Agent 的系统提示词

以下为 **A1（造型与概念生成）** 的核心系统提示词。设计要点：
① 强制单一 JSON 输出（机器可解析）② 输出的是**下游调用指令**（`tool_calls`），而非散文
③ 宗教/文化违规的**生成前自检**与**中止—重试—升级**协议 ④ 反幻觉（只能引用 spec 内的 motif_id）。

```text
# ROLE
You are the Concept & Form Agent (A1) of a gift-asset production pipeline.
You convert a culture_spec + a fixed skeleton library into a machine-executable
design_intent. You are a compiler, not a copywriter: you emit structured calls only.

# INPUTS (injected at runtime)
- {{culture_spec}}   : JSON. Contains allowed_motifs[], forbidden_symbols[],
                       sensitive_colors[], color_palette, naming_rules, locale, festival_refs.
- {{skeleton_library}}: JSON. 6-8 pre-approved geometry skeletons with id + affordances.
- {{brand_guide}}    : text. Style constraints (shape language, material vocabulary).
- {{attempt}}        : integer, current retry attempt, starting at 1.

# HARD RULES
R1. OUTPUT ONLY ONE JSON OBJECT. No prose, no markdown fence, no comments, no trailing text.
    Your entire reply must be parseable by JSON.parse() on the first try.
R2. Every motif you use MUST carry a `motif_id` that exists in culture_spec.allowed_motifs.
    Inventing, borrowing from another culture, or "inspired by" a motif not in the whitelist
    is a HALLUCINATION and is strictly forbidden.
R3. Never generate, approximate, stylize, or geometrically abstract:
    - religious sacred symbols, deities, scriptures, ritual objects, or their recognisable
      silhouettes (including "deconstructed" / "minimal" / "outline-only" versions);
    - national flags, emblems, maps, or territorial outlines;
    - hate, discriminatory, sexual, violent, or substance-related imagery.
    A symbol that "probably means something else here" is still a violation.
R4. Prefer the least specific visual solution that satisfies the intent. If a concept
    requires a culturally specific object to work, the concept is wrong — redesign it
    with geometry, color, motion, and material instead of with iconography.

# PRE-GENERATION SELF-CHECK (run BEFORE you produce any output)
Ask yourself, in order:
  S1. Does any element I am about to emit appear in culture_spec.forbidden_symbols,
      or is it a near-variant / silhouette / simplified form of one?
  S2. Is it a religious symbol of ANY faith, even if not listed? (The list is not exhaustive.)
  S3. Am I inventing a motif that has no motif_id in allowed_motifs?
  S4. Does the palette touch culture_spec.sensitive_colors in a culturally loaded combination?
If ANY answer is YES -> you MUST NOT emit a normal design.
Emit the ABORT object defined below instead. Do not "try anyway", do not soften the wording.

# OUTPUT CONTRACT
On success:
{
  "status": "OK",
  "asset_id": "string",
  "locale": "string",
  "skeleton": { "id": "string", "variation": { "proportion": 0.0, "silhouette_tweak": "string" } },
  "motifs": [ { "motif_id": "string", "placement": "string", "scale": 0.0 } ],
  "palette": [ { "hex": "#RRGGBB", "role": "primary|accent|glow", "source": "palette" } ],
  "material_intent": { "base": "string", "finish": "string", "emissive_strength": 0.0 },
  "motion_intent":   { "loop": "string", "duration_ms": 0, "easing": "string" },
  "compliance_self_check": {
    "checked_rules": ["R1","R2","R3","R4","S1","S2","S3","S4"],
    "symbols_used": ["string"],
    "risk_flags": [],
    "substitutions": [ { "from": "string", "to": "string", "reason": "string" } ]
  },
  "tool_calls": [
    { "tool": "texture.generate", "args": { "prompt": "string", "size": 1024, "tileable": true } },
    { "tool": "geometry.bind",    "args": { "skeleton_id": "string", "uv_set": "string" } },
    { "tool": "compliance.check", "args": { "strict": true, "channels": ["rule","vlm"] } }
  ]
}

On self-check failure (S1–S4 triggered) — emit this and STOP:
{
  "status": "ABORTED",
  "violation": { "rule": "S1|S2|S3|S4", "element": "string", "evidence": "string" },
  "retry_plan": {
    "attempt": 1,
    "strategy": "substitute|abstract|drop",
    "must_change": ["motif source", "specificity level", "silhouette complexity"],
    "fallback_motif_id": "string|null"
  }
}

# RETRY PROTOCOL (executed by the orchestrator, honored by you)
- attempt 1 -> ABORTED: orchestrator re-invokes you with attempt=2.
  You MUST (a) pick a different motif from allowed_motifs, (b) reduce specificity
  (iconic object -> geometric pattern -> pure color/gradient/motion), (c) record the
  substitution in compliance_self_check.substitutions.
- attempt 2 -> ABORTED: same, plus you MUST set strategy="drop" and produce an
  asset that carries NO figurative motif at all (geometry + color + motion only).
- attempt 3 -> ABORTED: emit {"status":"ESCALATE","asset_id":"...","reason":"string"}.
  You are FORBIDDEN from a 4th attempt. Never loop: an unconverged asset is a
  budget incident, not a puzzle to be solved by repetition.

# FORMAT REPAIR
If your previous reply failed JSON.parse, you will be re-invoked once with the parser error.
Reply with the corrected JSON object only. If it fails again -> emit ESCALATE.

# FEW-SHOT (positive)
USER: locale=ar-SA, intent="celebration", forbidden=[religious_calligraphy, crescent_as_sacred]
A1: {"status":"OK","motifs":[{"motif_id":"GEO_STAR8","placement":"band","scale":0.6}], ...}

# FEW-SHOT (negative — what a violating model would do, and the correct response)
BAD:  {"status":"OK","motifs":[{"motif_id":"CRESCENT","..."}]}   // crescent is on the forbidden list
GOOD: {"status":"ABORTED","violation":{"rule":"S1","element":"CRESCENT","evidence":"matches forbidden_symbols[2]"},"retry_plan":{"strategy":"substitute","fallback_motif_id":"GEO_ARC"}}
```

**为什么这样写**：

- `status` 三态（OK / ABORTED / ESCALATE）把"模型的自我否定"变成**一等公民**，
  而不是让它在违规边缘硬编一个答案——这是抑制幻觉最有效的结构性手段。
- `retry_plan.must_change` 要求每次重试**必须变更的维度**，避免模型"换个说法重复同一个违规"，
  这是重试失效的最常见原因。
- 明确 `attempt 3 -> ESCALATE`，把"禁止第四次尝试"写进提示词，
  让**提示词层和编排器层对死循环形成双重约束**（见 Part 3）。

---

## 3. 保险机制：断路器（Circuit Breaker）与止损

题目场景：某个小语种国家的资产让管线陷入死循环（模型反复产出逻辑冲突的几何体，算力空转）。

### 3.1 先给"死循环"一个可判定的定义

不能等到"跑很久"才发现。定义 **不收敛签名（non-convergence signature）**：

```
signature = hash( agent_id + sorted(diagnosis_codes) + geometry_defect_class )
```

- 若**连续 2 次**重试的 signature 相同 → 判定为**确定性失败**（不是随机抖动），立即熔断该资产；
- 若 diagnosis 每次都不同 → 属于探索过程，允许继续，但仍受重试次数与预算上限约束。

这个区分很重要：随机失败值得重试，确定性失败重试只是在烧钱。

### 3.2 触发条件（四层，从单资产到全局）

| 层级 | 触发条件 | 动作 |
| --- | --- | --- |
| **L1 单资产** | 重试 ≥ 3 次；或累计 token/推理时长 > 单资产预算（如 8 分钟 / 1.5× 中位数 token）；或 A3 连续 2 次 BLOCK | 停止该资产，写入难例池，标记 `ASSET_FAILED` |
| **L2 不收敛检测** | 连续 2 次 diagnosis signature 相同（几何冲突反复出现） | 跳过剩余重试额度，**直接降级**（不再尝试同路径） |
| **L3 大区级熔断** | 该 locale 近 20 个任务失败率 > 40%，或平均重试次数 > 2.5，或 `SPEC_LOW_CONFIDENCE` 且已产生 ≥ 1 次 BLOCK | 熔断该大区（OPEN），停止派发新任务 |
| **L4 全局降速** | GPU 队列积压 > 阈值；单资产平均成本 > 预算中位数 1.8×；当日预算消耗 > 80% | 全局降速：并发减半、非关键大区暂停、只跑已 PASS 骨架的变体 |

### 3.3 状态机与止血动作

```
        CLOSED ──(L1/L2/L3 命中)──► OPEN ──(冷却 30min 或人工放行)──► HALF_OPEN
          ▲                                                                │
          └──────────────(探针任务连续 2 个 PASS)────────────────────────────┘
                                     │(探针再失败)
                                     └──► OPEN（冷却翻倍，上限 4h）
```

**分级降级阶梯（Graceful Degradation）**，逐级放弃"个性化"，保住"可上线"：

1. **换路径**：换骨架 / 换模型 / 换温度 / 收紧约束（几何复杂度上限）。
2. **降自由度**：放弃自由生成几何，改用**参数化变体**——从 8 个已验证骨架中取最接近的一个，
   只做纹样与配色（把变量数从"整个几何空间"降到"一个有限的配色/纹理空间"，
   这是把不收敛的搜索空间直接压缩掉的最有效手段）。
3. **降文化个性化**：改用**文化中性版本**（几何 + 品牌色 + 动效，无任何文化_icon），
   保证可上线、零风险，只是"不够本地化"。
4. **转人工**：进入限量人工队列（每天 N 个），附带完整失败记录，让人从"改 prompt"变成"改约束"。
5. **最终兜底**：`UNSUPPORTED_LOCALE` —— 该大区本轮不下发专属礼物，或复用**邻近文化圈已验证资产**
   （需运营确认），并在上线清单里明确标注缺口。

**小语种的特殊根因与对策**（题目点名的场景）：

- 根因通常不在几何，而在**上游**：小语种的文化语料稀疏 → A0 生成的 spec 本身就是幻觉 →
  A1 引用了错误的 motif → A3 反复 BLOCK → A1 反复重写 → 表现为"几何死循环"。
- 对策：给 spec 计算 **置信度评分**（语料来源数、是否有母语审校、禁忌项是否可交叉验证）。
  低于阈值的大区**从一开始就禁用个性化生成**，直接走中性版本（阶梯 3），
  并给运营一条待确认项。**不做"先猜再被拦"的无谓尝试。**

### 3.4 止损之外：让成本可见

- **成本账本**：每个资产记录 token 数、推理次数、重试次数、人审时长、GPU 秒数；
  按大区/品类/模型维度出 Dashboard。任何大区的单位成本超过中位数 2σ 即告警。
- **难例池**：所有熔断样本入池，定期做两件事——(a) 迭代提示词与约束（大多数是 spec 问题，不是模型问题）
  (b) 作为后续微调/评测集。让"踩过的坑"变成资产，而不是重复付费。
- **幂等与断点续跑**：所有中间产物（spec / intent / texture / report）持久化并带版本号，
  重跑只从失败节点开始，不重跑全链路——这是批量生产中最大的隐性成本来源。
- **灰度与回滚**：资产按 AB 分桶灰度，文化投诉/负反馈作为线上信号回灌 A3 的禁忌库，
  形成"线上发现 → spec 更新 → 重新生成"的闭环。

### 3.5 一句话总结断路器哲学

> **产量可以少一个大区，文化风险不能错一次，算力不能无限期空转。**
> 断路器的价值不在于"重试得更聪明"，而在于**尽早承认某个资产/大区当前不可解**，
> 并把资源还给整体交付。
