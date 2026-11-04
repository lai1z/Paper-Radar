# 📡 Paper Radar · 每日 arXiv 精选

> 每天自动把 arXiv 的上千篇新投稿，筛成一份只属于你自己方向的短名单。

arXiv 每天新增上千篇论文，真正和你相关的那几十篇散在分类列表里。这个项目把"找论文"拆成三层，每天自动跑完，**整个管线和筛选口径都可以换成你自己的领域**：

- **全量抓取**：按你配置的分类读取 arXiv 当日新投稿的标题、摘要、作者（只读列表页，不逐篇调用 API）。
- **语义闸门**：把每篇的标题、摘要、分类交给一个结构化决策模型（默认 TypeSafe Jev），它返回"这篇属于目标领域的概率"。因为是语义判断而不是关键词匹配，换个说法也认得出——关键词筛选最容易漏掉的正是这种改写。
- **精选解读**：每天最多发布 50 篇成功的 AI 解读，不再新增只有摘要的长尾记录；不足 50 篇时不凑数。解读基于标题与摘要，不代表阅读全文或独立核验论文结论。

**当前仓库里的参考配置是世界模型 / 具身智能方向**（分类 cs.CV、cs.AI、cs.LG、cs.RO、cs.GR）——它只是这套通用管线的一个实例。

## 换成你自己的领域

三个地方，全部写在配置里，不用改代码：

1. **抓哪些分类**：仓库变量 `CATEGORIES`，例如 `cs.CL,cs.LG`。
2. **什么算你的领域**：`config/research-scope.json` 里的 `true` / `false` 两段英文描述。这是整个系统的"口味"，写得越具体，语义闸门判得越准。
3. **筛选要多严**：`SCREEN_THRESHOLD`（相关度阈值，默认 0.7）。当前每日工作流明确使用 `--max-papers 50 --tail-max 0`；旧的 `SCREEN_MAX_PAPERS` / `SCREEN_TAIL_MAX` 变量不会改变这两个上限。

改完提交，下一次运行就按新口径走。

## 你会得到什么

- **阅读工作台**：按日期、研究主题、分类与搜索浏览，切换卡片和速览布局。先看核心方法与关键结果，再按需展开原始摘要与对应依据；页面区分最近成功检查和最新收录日期。
- **待读与 Zotero**：保存完整解读快照，标记已读；保留 JSON 导出/导入备份。复制 arXiv ID 到 Zotero“通过标识符添加条目”，由 Zotero 获取元数据及 PDF；CSL JSON 是仅含元数据的另一选项。清单保存在当前浏览器，不自动跨设备同步。
- **数据**：`data` 分支按天保存 `<date>.jsonl`（筛选后的原始元数据）与 `<date>_AI_enhanced_<lang>.jsonl`（带中文要点），可以直接当数据集复用。
- **费用记录**：实际费用取决于平台、模型和处理量；日志在平台支持时报告消费变化。逐篇检查点避免普通重跑重复处理已成功的论文。

## 自己部署

1. Fork 本仓库。
2. `Settings → Secrets and variables → Actions` 添加 Secrets：`OPENAI_API_KEY`、`OPENAI_BASE_URL`（任意 OpenAI 兼容端点）、`TOKEN_GITHUB`（推送数据分支用）、`ACCESS_PASSWORD`（可选）。
3. 添加 Variables：`CATEGORIES`、`LANGUAGE`、`MODEL_NAME`、`EMAIL`、`NAME`，以及可选的 `SCREEN_THRESHOLD`。
4. `Settings → Pages` 选择从 `main` 分支发布。
5. 允许工作流通过 `GITHUB_TOKEN` 写入仓库；将 `js/data-config.js` 的仓库信息设为自己的仓库。在 Actions 里手动跑一次 `Paper Radar`，之后每天定时自动执行。

## 版权与来源

本项目是基于 [dw-dengwei/daily-arXiv-ai-enhanced](https://github.com/dw-dengwei/daily-arXiv-ai-enhanced) 修改的 fork，原作者 **Wei Deng、Jian Guan**，遵循上游的 Apache-2.0（仓库内 LICENSE 为 Modified Apache License）。原始版权与许可证保持不变（见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)）。**使用或再分发本仓库时，请一并保留上游署名与许可证。**

## 每日流程与 Jev 语义闸门

每日任务不再用关键词筛选论文，流程是：按分类全量抓取 → 对照成功发布历史跨日去重 → **Jev 语义闸门** → AI 解读 → 合并当日成功结果 → 发布 data 分支。计划时间是 UTC 01:30（北京时间 09:30），GitHub 调度可能延迟。

- 抓取：按 `CATEGORIES` 变量里的分类（默认 `cs.CV,cs.AI,cs.LG,cs.RO,cs.GR`）读取 arXiv 每日列表里的完整元数据，不再逐篇调用 arXiv API，也不在爬虫里丢弃论文。
- 闸门：`ai/screen.py` 把标题、摘要和分类交给 TypeSafe Jev，返回领域相关度分数；分数不代表论文质量或结论可靠性。当前最多选择 50 篇，不收录长尾；判定失败时仅在剩余额度内保留候选。全部分数保存在工作流产物里。
- 总结：`ai/enhance.py` 只处理通过闸门的论文，并开启并发（`--max_workers`）。

领域定义在 [`config/research-scope.json`](config/research-scope.json) 的 `true` / `false` 两段文字里，改这两段就等于改闸门口径；`ai/screen.py`（每日闸门）和 `eval/recall_eval.py`（离线评测）读的是同一份文件，不会各改各的。

## 页面上的关键词筛选

设置页里的关键词用于浏览时的匹配和排序；勾选“只看偏好匹配”后才限制显示范围。比较时忽略大小写、空格、连字符和下划线，因此 `V-JEPA` 也能命中 `VJEPA`；多个词用逗号分隔、`|` 表示或。这些设置只存在浏览器本地，不影响每日抓取。保存失败时页面会明确提示并保留编辑内容；不同标签页的未保存修改不会被静默覆盖。

## 来源保护与手动更新解读

原始标题、作者、摘要、ID、日期与链接独立于 AI 注释保存。读取缓存时以本次来源元数据为准；缺失发布日期时不把收录日期当成发布日期。新版关键结果需要可在摘要中定位的原句，阿拉伯数字也须在依据中出现。这些检查能发现部分错误，不能证明语义推断或科学结论，重要比较仍应核对原文的条件。

普通重跑会去重、恢复检查点并合并当天结果，失败或空结果不会覆盖成功数据。在 **Actions → Paper Radar → Run workflow** 勾选 `refresh_digest`，可以明确请求更新今天已经收录的最多 50 篇解读，用于查看新格式和提示词的效果。该模式不会新增论文或改动原始元数据；更新失败时保留旧解读，独立刷新检查点支持恢复。当天尚无成功收录时执行普通流程。

界面由 `main` 分支的 Pages 发布，论文与检查状态来自 `data` 分支；仅修改界面不需要重新调用模型。

## 中断恢复与数据完整性

爬虫核对每个分类的新投稿及交叉投稿计数，所有分类和导出均成功后才使用本次结果；网络失败或页面结构异常不会被当成“没有新论文”。发布前会再次对照成功历史清理旧重试队列；已经生成、但因任务中断尚未发布的解读会从检查点恢复，不重复调用模型，并与新论文共享每日 50 篇上限。

页面加载失败时提供重试，不把上一个日期的论文显示为新日期的数据。待读清单使用浏览器支持的 Web Locks 协调多个标签页的保存；存储损坏时仍可导出原始备份，不会自动清空。旧浏览器不支持 Web Locks 时仅保证当前页面内的写入顺序。

## 验证

```sh
uv sync
uv run python -m unittest discover -s ai/tests -v
uv run python -m unittest discover -s daily_arxiv/tests -v
node --test tests/*.test.cjs
```

推送代码和提交 PR 时，`Validate Paper Radar` 工作流自动执行上述回归测试，不调用付费模型。

浏览器回归使用 Playwright，运行 `tests/*.browser.cjs`，覆盖搜索和主题筛选、移动端、键盘操作、摘要依据、待读并发保存、Zotero 导出、网络失败及重试、日期组件不可用、损坏或被禁用的本地存储，以及设置保存失败后的恢复。
