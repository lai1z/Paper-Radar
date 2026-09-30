# 📚 arXiv 每日论文精选（可定制）

> 每天自动把 arXiv 的上千篇新投稿，筛成一份只属于你自己方向的短名单。

arXiv 每天新增上千篇论文，真正和你相关的那几十篇散在分类列表里。这个项目把"找论文"拆成三层，每天自动跑完，**整个管线和筛选口径都可以换成你自己的领域**：

- **全量抓取**：按你配置的分类读取 arXiv 当日新投稿的标题、摘要、作者（只读列表页，不逐篇调用 API）。
- **语义闸门**：把每篇的标题、摘要、分类交给一个结构化决策模型（默认 TypeSafe Jev），它返回"这篇属于目标领域的概率"。因为是语义判断而不是关键词匹配，换个说法也认得出——关键词筛选最容易漏掉的正是这种改写。
- **分层产出**：概率最高的一批生成中文要点；次高的一批只收录标题与原始摘要，标注「仅收录」；低于下限的丢弃。这样既控制了模型成本，又不会因为卡分数线而漏掉边缘但有价值的论文。

**当前仓库里的参考配置是世界模型 / 具身智能方向**（分类 cs.CV、cs.AI、cs.LG、cs.RO、cs.GR）——它只是这套通用管线的一个实例。

## 换成你自己的领域

三个地方，全部写在配置里，不用改代码：

1. **抓哪些分类**：仓库变量 `CATEGORIES`，例如 `cs.CL,cs.LG`。
2. **什么算你的领域**：`config/research-scope.json` 里的 `true` / `false` 两段英文描述。这是整个系统的"口味"，写得越具体，语义闸门判得越准。
3. **每天要多少、要多严**：`SCREEN_THRESHOLD`（核心概率下限，默认 0.7）、`SCREEN_MAX_PAPERS`（每天最多总结多少篇，默认 50）、`SCREEN_TAIL_THRESHOLD`（长尾下限，默认 0.3）、`SCREEN_TAIL_MAX`（长尾最多收录多少篇，默认 100）。

改完提交，下一次运行就按新口径走。

## 你会得到什么

- **网页**：按分类分区浏览，可切换日期，右上角关键词框做纯文本筛选（忽略大小写、空格和连字符，输入 `V-JEPA` 也能命中 `VJEPA`）。
- **数据**：`data` 分支按天保存 `<date>.jsonl`（筛选后的原始元数据）与 `<date>_AI_enhanced_<lang>.jsonl`（带中文要点），可以直接当数据集复用。
- **成本透明**：每天日志打印两笔真实花费——语义闸门（按输入计费，约 0.05 美元/天）与 AI 总结（约 0.03 美元/天），长尾不调用模型、成本为 0。

## 自己部署

1. Fork 本仓库。
2. `Settings → Secrets and variables → Actions` 添加 Secrets：`OPENAI_API_KEY`、`OPENAI_BASE_URL`（任意 OpenAI 兼容端点）、`TOKEN_GITHUB`（推送数据分支用）、`ACCESS_PASSWORD`（可选）。
3. 添加 Variables：`CATEGORIES`、`LANGUAGE`、`MODEL_NAME`、`EMAIL`、`NAME`，以及上面提到的四个 `SCREEN_*` 可选项。
4. `Settings → Pages` 选择从 `main` 分支发布。
5. 在 Actions 里手动跑一次 `arXiv-daily-ai-enhanced`，之后每天定时自动执行。

## 版权与来源

本项目是基于 [dw-dengwei/daily-arXiv-ai-enhanced](https://github.com/dw-dengwei/daily-arXiv-ai-enhanced) 修改的 fork，原作者 **Wei Deng、Jian Guan**，遵循上游的 Apache-2.0（仓库内 LICENSE 为 Modified Apache License）。原始版权与许可证保持不变（见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)）。**使用或再分发本仓库时，请一并保留上游署名与许可证。**

## 每日流程与 Jev 语义闸门

每日任务不再用关键词筛选论文，流程是：按分类全量抓取 → 七天去重 → **Jev 语义闸门** → AI 总结 → 生成页面数据。

- 抓取：按 `CATEGORIES` 变量里的分类（默认 `cs.CV,cs.AI,cs.LG,cs.RO,cs.GR`）读取 arXiv 每日列表里的完整元数据，不再逐篇调用 arXiv API，也不在爬虫里丢弃论文。
- 闸门：`ai/screen.py` 把每篇的标题、摘要和分类交给 TypeSafe Jev（`typesafe/jev-1.13`，OpenRouter 的 System One 决策接口），它返回“属于目标领域”的概率。四个旋钮：`SCREEN_THRESHOLD`（核心概率下限，默认 0.7）、`SCREEN_MAX_PAPERS`（每天最多总结多少篇，默认 50，0 表示不限制）、`SCREEN_TAIL_THRESHOLD`（长尾收录下限，默认 0.3）和 `SCREEN_TAIL_MAX`（长尾每天最多收录多少篇，默认 100，0 表示不收录长尾）。判定失败时保留论文（fail-open）且不占用每日限额，全部论文的分数写到工作流产物里，便于复盘或换阈值重跑。
- 长尾论文（核心之外、分数仍达到长尾下限的论文，包括被每日上限挤出的高分论文）按分数取前 `SCREEN_TAIL_MAX` 篇，只收录标题与原摘要，不调用总结模型；页面和 Markdown 里会标注“仅收录（相关度中等，未做 AI 总结）”。
- 总结：`ai/enhance.py` 只处理通过闸门的论文，并开启并发（`--max_workers`）。

领域定义在 [`config/research-scope.json`](config/research-scope.json) 的 `true` / `false` 两段文字里，改这两段就等于改闸门口径；`ai/screen.py`（每日闸门）和 `eval/recall_eval.py`（离线评测）读的是同一份文件，不会各改各的。

## 页面上的关键词筛选

设置页里的关键词只是浏览用的字面筛选：输入 `world model`，页面就只显示标题或摘要里包含这个词的论文。比较时忽略大小写、空格、连字符和下划线，因此 `V-JEPA` 也能命中 `VJEPA`；多个词用逗号分隔、`|` 表示或。这些设置只存在浏览器本地，不影响每日抓取。
