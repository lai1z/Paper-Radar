# 🚀 daily-arXiv-ai-enhanced

This repository is deployed to automatically crawl arXiv papers relevant to my research interests on a daily basis.

## 每日流程与 Jev 语义闸门

每日任务不再用关键词筛选论文，流程是：按分类全量抓取 → 七天去重 → **Jev 语义闸门** → AI 总结 → 生成页面数据。

- 抓取：按 `CATEGORIES` 变量里的分类（默认 `cs.CV,cs.AI,cs.LG,cs.RO,cs.GR`）读取 arXiv 每日列表里的完整元数据，不再逐篇调用 arXiv API，也不在爬虫里丢弃论文。
- 闸门：`ai/screen.py` 把每篇的标题、摘要和分类交给 TypeSafe Jev（`typesafe/jev-1.13`，OpenRouter 的 System One 决策接口），它返回“属于目标领域”的概率。两个旋钮：`SCREEN_THRESHOLD`（概率下限，默认 0.7）和 `SCREEN_MAX_PAPERS`（每天最多保留多少篇，按分数取前 N，默认 50，设为 0 表示不限制）。判定失败时保留论文（fail-open）且不占用每日上限，全部论文的分数写到工作流产物里，便于复盘或换阈值重跑。
- 总结：`ai/enhance.py` 只处理通过闸门的论文，并开启并发（`--max_workers`）。

领域定义在 [`config/research-scope.json`](config/research-scope.json) 的 `true` / `false` 两段文字里，改这两段就等于改闸门口径；`ai/screen.py`（每日闸门）和 `eval/recall_eval.py`（离线评测）读的是同一份文件，不会各改各的。

## 页面上的关键词筛选

设置页里的关键词只是浏览用的字面筛选：输入 `world model`，页面就只显示标题或摘要里包含这个词的论文。比较时忽略大小写、空格、连字符和下划线，因此 `V-JEPA` 也能命中 `VJEPA`；多个词用逗号分隔、`|` 表示或。这些设置只存在浏览器本地，不影响每日抓取。
