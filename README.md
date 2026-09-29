# 🚀 daily-arXiv-ai-enhanced

This repository is deployed to automatically crawl arXiv papers relevant to my research interests on a daily basis.

## 关键词预筛选

每日任务读取 [`config/interest-filter.json`](config/interest-filter.json)，在调用 AI 之前根据论文标题、摘要、分类、备注和作者进行筛选。设置页会读取同一配置；修改关键词后点击“应用到每日任务”，把自动复制的 JSON 粘贴到打开的 GitHub 编辑器并提交。下一次定时运行或手动运行会使用新配置。

- `enabled` 为 `true` 时必须至少填写一个关键词或作者，防止误处理全部论文。
- 多个关键词之间是“或”关系。
- 同一主题的别名用 `|` 分隔，例如 `vision language action | VLA`。
- 模糊匹配支持大小写、连字符、词序和轻微拼写差异；语义近义词请显式写成别名，避免不可控的误匹配。
- 爬虫直接读取 arXiv 每日列表里的完整元数据，不再逐篇调用 arXiv API。
