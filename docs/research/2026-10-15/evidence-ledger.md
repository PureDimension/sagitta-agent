# Sagitta 调研证据记录

核查日期：2026 年 10 月 15 日。主结论见 [调研报告](conclusions.md)，验证方法见 [验收方案](evaluation-plan.md)。下列为与决策有关的一手来源摘要；论文实验、厂商工程案例和系统建议分别理解。

## 经验学习与内部学习

| 编号与来源 | 发现及适用范围 | 对 Sagitta 的含义 |
| --- | --- | --- |
| E01 [ExpeL](https://arxiv.org/html/2308.10144) | 从成功、失败的对比中提炼见解，结合示例帮助固定参数的模型执行新任务。提炼模型本身的能力影响结果。 | 抽象经验有实验基础；提炼质量也要评估。 |
| E02 [ReasoningBank v2](https://arxiv.org/html/2509.25140v2) | 在浏览及软件任务中提炼成功与失败的推理策略。代理成功标签依赖 LLM judge；附录明确采用简单检索和直接追加，长期清理仍是后续方向。 | 借鉴学习内容与对比方法，补上证据分级、修正和淘汰。 |
| E03 [ACE v1](https://arxiv.org/html/2510.04618v1) | 采用生成、反思、整理及局部增量更新，避免整份上下文反复重写造成信息坍缩。实验含 DeepSeek-V3.1；作者明确指出反思器弱时记忆会有害。 | 增量维护优于整库重写的方向值得验证；角色数和长上下文量取决于场景。 |
| E04 [GEPA v2 摘要](https://arxiv.org/abs/2507.19457v2)、[官方实现](https://github.com/gepa-ai/gepa) | 利用轨迹反馈提出、测试并筛选提示词变化。核查了摘要和官方实现说明，论文 HTML 获取失败。 | 可用于离线提出系统提示改进；按用户约束，发布前由用户审查。 |
| E05 [When Continual Learning Moves to Memory v1](https://arxiv.org/html/2604.27003v1) | Qwen-Plus 在 ALFWorld、BabyAI 的顺序任务实验中，抽象经验通常比原始轨迹更安全；更细粒度、更频繁检索也可能加剧遗忘。每条件仅两次运行。 | 必须同时测迁移、负迁移和旧能力保留，不能用记忆命中率替代成长。 |
| E06 [SkillFlow v1](https://arxiv.org/html/2604.17308v1) | 166 个任务、20 个共享工作流程的任务族；技能积累的收益随模型变化，也有退步。正文、附录对一个原始历史基线的数值存在矛盾。 | 采用“技能使用不等于收益”的定性结论；避免依赖矛盾基线或跨包装器比较模型排名。 |
| E07 [LifelongAgentBench v3](https://arxiv.org/html/2505.11942v3) | 数据库、操作系统和知识图谱任务可自动验证。增加历史轨迹会产生收益递减、上下文负担及模型差异。 | 采用其顺序任务与保留能力测试思路；开放式管理仍需专门样例。 |
| E08 [Voyager](https://arxiv.org/abs/2305.16291) | Minecraft 中积累可执行技能，结合环境反馈探索与复用；主张限于该环境实验。 | 技能是有效学习载体之一；新执行代码仍受 Sagitta 的用户审查边界约束。 |
| E09 [MemGen v1](https://arxiv.org/html/2509.24704v1)、[官方代码与更正](https://github.com/bingreeky/MemGen) | 使用模型内部状态、潜在记忆序列及训练过的 Weaver/Trigger；固定主干仍包含辅助参数训练。实现说明有模板修正及未完整发布的复现材料。 | 属于模型训练和推理改造路线，普通文本 API 外挂无法直接复现。 |
| E10 [Titans v1](https://arxiv.org/html/2501.00663v1) | 提出带测试时更新的神经记忆架构，实验重在序列建模与长上下文。 | 是底层模型方向；长文本记忆实验尚不能证明管理经验或人格成长。 |
| E11 [LifeSkill v1](https://arxiv.org/html/2606.04815v1) | 基于 Llama-3.1-8B，在可自动验证的环境中训练技能提炼与策略参数，将技能辅助下的成功转化为参数更新。 | 更接近内部能力固化，但需要训练、算力及可信奖励；开放目标的反馈问题仍然存在。 |

## 长程任务与多 agent 管理

| 编号与来源 | 发现及适用范围 | 对 Sagitta 的含义 |
| --- | --- | --- |
| E12 [LHAW v1](https://arxiv.org/html/2602.10525v1) | 将长程任务变成可控的欠明确任务，考察发现歧义、澄清和使用信息；更复杂的计划提示未稳定优于简单方法。 | 自主探索和何时询问需要单独评测；“先自动生成大计划”无法代替意图理解。 |
| E13 [Task Alignment Benchmark v1](https://arxiv.org/html/2605.12233v1) | 在终端任务中混合必要线索与无关指令。完成任务与抵抗无关目标是不同能力；若一律过滤环境内容，也会丢失必要线索。 | 新任务要能说明与原始委托的关系，同时保留从环境发现合理工作的能力。 |
| E14 [MAST v3](https://arxiv.org/html/2503.13657) | 研究多 agent 的重复步骤、目标偏离、过早终止及验证错误等失败。新版数据量与早期摘要不同。 | 多角色分工本身不足以保证可靠；终止和验证必须进入设计。 |
| E15 [Scaling Agent Systems v3](https://arxiv.org/html/2512.08296) | 在控制工具、提示和算力的实验中，多 agent 的收益依赖任务结构；并行可拆工作可受益，顺序任务可能明显退步。新版修订了早期统计结论。 | 按依赖关系决定派单，保留单 agent 基线；旧版“45% 阈值”等数值不作为产品规则。 |
| E16 [Anthropic 2025 long-running harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | 应用开发案例通过持久进度、功能清单、增量交付和端到端检查减轻过早完成。 | 支持外置目标和可恢复工作状态，不能直接推广为所有开放任务的质量保证。 |
| E17 [Anthropic 2026 harness](https://www.anthropic.com/engineering/harness-design-long-running-apps) | 从简短需求扩展计划，执行前约定阶段验收，独立测试运行中的应用。作者也报告验收器误批、迭代复杂度增加和较高成本。 | 阶段验收值得借鉴；自动扩写需求和评审角色仍要校准、消融。 |
| E18 [OpenAI 长程 Codex 案例](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)、[Remote 工作指南](https://developers.openai.com/blog/mastering-codex-remote-for-engineering) | 前者给出约 25 小时的应用开发实验，使用明确规格和验证；后者说明持久 Goal、计划及远程工作入口。 | Codex 已有长程能力；用户报告的过早关闭和空转需要更具体的保障及对照测试。案例时长也不能证明抽象目标持续对齐。 |
| E19 [METR 方法限制](https://metr.org/notes/2026-01-22-time-horizon-limitations/) | “任务时长”是人类基线耗时，50% 成功时域并非可放心委派的范围。高可靠性及真实协作工作缺少足够基准。 | 衡量委托效果、返工和人工介入，避免把连续运行时长当作可靠性。 |

## 执行、评估与独立判断

| 编号与来源 | 发现及适用范围 | 对 Sagitta 的含义 |
| --- | --- | --- |
| E20 [Temporal Activity Execution](https://docs.temporal.io/activity-execution)、[AWS 重试与幂等](https://docs.aws.amazon.com/durable-execution/patterns/best-practices/idempotency/) | 执行可重试、超时，取消需要执行端配合；重放与重试可能重复副作用。持久运行框架也无法普遍保证外部动作恰好一次。 | 持久派单、接收确认、去重、状态核对和真实取消必须一起设计。引用原理不代表选用这些产品部署。 |
| E21 [Anthropic Managed Agents](https://www.anthropic.com/engineering/managed-agents) | 将会话事件、推理端和执行环境分开，持久事件支持恢复与重新获取上下文。 | 过程记录应独立于当前上下文与模型；持久日志也不负责判断方向对错。 |
| E22 [Agent evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | 组合程序、模型和人工评估；区分偶尔成功与重复运行可靠性，评估器也需校准。 | 同时检查真实结果及约束，重复运行，并抽样审查模型评分。 |
| E23 [反迎合研究 v4](https://arxiv.org/html/2310.13548) | 用户偏好反馈可能奖励迎合甚至牺牲正确性；实验限于研究中的模型与任务。 | 个性化满意度和事实正确性分别检验。 |
| E24 [任务相关的自我纠错 v1](https://arxiv.org/html/2606.23196v1) | 内部复核在某些约束明确的任务上有帮助，收益依任务和模型而变；未覆盖一般开放式管理。 | “AI 完全无法自纠”过强；“再想一次即可可靠纠错”也缺少普遍依据。 |

## 证据取舍

- 以明确版本为准。Scaling Agent Systems、MAST、GEPA 等修订过数据或结论，正文采用已读版本；网页产品能力以核查日期为准。
- SkillFlow 原始历史基线的矛盾削弱了该数值的可用性；保留其他实验的方向性观察，成长建议同时参考 E01、E02、E05、E07。
- MemGen 的原始成绩与当前实现的模板修正、复现状态需要分别看待，本文仅采用可从方法和训练说明确认的接口要求。
- [TiGanEval](https://arxiv.org/abs/2610.17757) 于 2026 年 10 月 13 日发布，针对欠明确指令的研究高度相关，但过新，暂作后续跟踪项。
- 外部论文对基准任务的收益，都需要在 Sagitta 的真实管理任务及选定模型上重新验证。本文没有据此声称 Sagitta 已经获得这些提升。
