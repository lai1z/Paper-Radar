#!/usr/bin/env python3
"""离线评测不同召回方案的召回率与成本。

思路：拿“加关键词过滤之前”的真实抓取数据当样本池（因此不受现有配置的选择偏差影响），
用一个参考模型逐篇判定“是否属于目标领域”作为标准答案，再对比各方案的召回/精确率/成本。

本脚本只做离线评测，不参与每日流程，也不会改动 data 分支。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "daily_arxiv"))

from daily_arxiv.interest_filter import InterestFilter  # noqa: E402

DOMAIN_TRUE = (
    "The paper studies world models, world simulators, or learned dynamics models for embodied, "
    "robotic, or physical agents. This includes: video generation/diffusion used for world simulation; "
    "JEPA-style predictive or joint-embedding architectures; latent dynamics or latent action models; "
    "embodied or physical AI; VLA / vision-language-action policies built on predictive or world models; "
    "and evaluation, benchmarks, or efficiency work (acceleration, distillation, quantization, real-time "
    "inference, memory reduction) on any of the above."
)

DOMAIN_FALSE = (
    "The paper is outside this scope: it does not study world models or learned dynamics/simulators for "
    "embodied or physical agents. Examples: pure NLP or speech, medical or clinical work, security or code "
    "generation, networking or wireless sensing, generic 3D reconstruction, or video work with no "
    "world-model / embodied-simulation component."
)

JUDGE_INSTRUCTIONS = (
    "Decide whether the following arXiv paper belongs to the reader's research area, described below.\n"
    f"IN SCOPE: {DOMAIN_TRUE}\n"
    f"OUT OF SCOPE: {DOMAIN_FALSE}\n"
    "Answer with exactly one word: YES or NO."
)

JEV_INSTRUCTIONS = "Does this arXiv paper belong to the reader's research area described in the criteria?"

# 免费“大网”：只做召回参考，不追求精确
BROAD_NET_RE = re.compile(
    r"(world\s*model|world\s*simulat|world\s*representation|learned\s+simulat|neural\s+simulat|"
    r"dynamics\s+model|latent\s+dynamics|latent\s+action|embodied|physical\s+ai|robot|manipulat|"
    r"navigation|video\s+generat|video\s+diffusion|diffusion\s+transformer|jepa|vla|rollout|"
    r"interactive\s+environment|policy\s+learn)",
    re.IGNORECASE,
)


def http_json(url: str, payload: dict, headers: dict, timeout: int = 120) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def http_text(url: str, timeout: int = 60) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "recall-eval"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8")


def paper_text(item: dict) -> str:
    return f"{item.get('title', '').strip()}\n\n{item.get('summary', '').strip()}"


class Judge:
    """参考标注：用可用的对话模型逐篇判定是否属于目标领域。"""

    def __init__(self, base_url: str, api_key: str, model: str, workers: int):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.workers = workers
        self.calls = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.errors = 0
        self.unparsed = 0

    def ask(self, item: dict) -> bool | None:
        payload = {
            "model": self.model,
            "temperature": 0,
            "max_tokens": 512,
            "messages": [
                {"role": "system", "content": JUDGE_INSTRUCTIONS},
                {
                    "role": "user",
                    "content": "Title and abstract:\n" + paper_text(item)[:12000] + "\n\nAnswer YES or NO:",
                },
            ],
        }
        try:
            data = http_json(
                f"{self.base_url}/chat/completions",
                payload,
                {"Authorization": f"Bearer {self.api_key}"},
            )
            self.calls += 1
            usage = data.get("usage") or {}
            self.prompt_tokens += int(usage.get("prompt_tokens") or 0)
            self.completion_tokens += int(usage.get("completion_tokens") or 0)
            message = data["choices"][0]["message"]
            content = (message.get("content") or "").strip().upper()
            if not content:
                content = (message.get("reasoning") or "").strip().upper()
            # 优先看开头，模型通常先给结论；否则看结尾（思考过程在前的模型）
            head = content[:60]
            head_match = re.search(r"\b(YES|NO)\b", head)
            if head_match:
                return head_match.group(1) == "YES", content
            all_matches = re.findall(r"\b(YES|NO)\b", content)
            if all_matches:
                return all_matches[-1] == "YES", content
            self.unparsed += 1
            if self.unparsed <= 3:
                print(f"  judge unparsed (len={len(content)}): {content[:160]!r}", file=sys.stderr)
            return None, content
        except Exception as error:  # noqa: BLE001
            self.errors += 1
            if self.errors <= 3:
                print(f"  judge error: {type(error).__name__}: {error}", file=sys.stderr)
            return None, f"<{type(error).__name__}: {error}>"


class Jev:
    """TypeSafe Jev：结构化决策模型，返回“属于该领域”的概率。"""

    def __init__(self, base_url: str, api_key: str, model: str, workers: int):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.workers = workers
        self.calls = 0
        self.input_tokens = 0
        self.cost = 0.0
        self.errors = 0

    def ask(self, item: dict) -> float | None:
        payload = {
            "model": self.model,
            "state": {"title": item.get("title", ""), "abstract": item.get("summary", "")},
            "questions": {
                "in_domain": {
                    "type": "noul",
                    "instructions": JEV_INSTRUCTIONS,
                    "criteria": {"true": DOMAIN_TRUE, "false": DOMAIN_FALSE},
                }
            },
        }
        try:
            data = http_json(
                f"{self.base_url}/systemone",
                payload,
                {"Authorization": f"Bearer {self.api_key}"},
            )
            self.calls += 1
            usage = data.get("usage") or {}
            self.input_tokens += int(usage.get("input_tokens") or 0)
            self.cost += float(usage.get("cost") or 0)
            answer = (data.get("answers") or {}).get("in_domain") or {}
            value = answer.get("noul")
            return float(value) if value is not None else None
        except Exception as error:  # noqa: BLE001
            self.errors += 1
            if self.errors <= 3:
                print(f"  jev error: {type(error).__name__}: {error}", file=sys.stderr)
            return None


def parallel(fn, items: list[dict], workers: int) -> list:
    if workers <= 1:
        return [fn(item) for item in items]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(fn, items))


def load_pool(owner: str, repo: str, dates: list[str]) -> list[dict]:
    papers: list[dict] = []
    for date in dates:
        url = f"https://raw.githubusercontent.com/{owner}/{repo}/data/data/{date}.jsonl"
        text = http_text(url)
        for line in text.strip().split("\n"):
            if not line.strip():
                continue
            item = json.loads(line)
            item["_date"] = date
            papers.append(item)
    return papers


def metrics(labels: list[bool], predicted: list[bool]) -> dict:
    tp = sum(1 for y, p in zip(labels, predicted) if y and p)
    fn = sum(1 for y, p in zip(labels, predicted) if y and not p)
    fp = sum(1 for y, p in zip(labels, predicted) if not y and p)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"tp": tp, "fn": fn, "fp": fp, "precision": precision, "recall": recall, "f1": f1}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dates", default="2026-09-21,2026-09-23", help="用于评测的历史日期（过滤前）")
    parser.add_argument("--limit", type=int, default=0, help="只评测前 N 篇（0 表示全部）")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--judge-model", default=os.environ.get("JUDGE_MODEL", "deepseek/deepseek-v4.1-flash"))
    parser.add_argument("--jev-model", default=os.environ.get("JEV_MODEL", "typesafe/jev-1.13"))
    parser.add_argument("--owner", default=os.environ.get("GITHUB_REPOSITORY_OWNER", "lai1z"))
    parser.add_argument("--repo", default=(os.environ.get("GITHUB_REPOSITORY", "lai1z/daily-arXiv-ai-enhanced").split("/")[-1]))
    parser.add_argument("--out", default="eval-out")
    parser.add_argument("--skip-jev", action="store_true")

    # 允许用 eval/eval_config.json 覆盖默认值，方便用提交文件的方式触发小样本试跑
    config_file = ROOT / "eval" / "eval_config.json"
    if config_file.exists():
        overrides = json.loads(config_file.read_text(encoding="utf-8"))
        allowed = {"dates", "limit", "workers", "judge_model", "jev_model", "out"}
        parser.set_defaults(**{key: value for key, value in overrides.items() if key in allowed})
        print(f"已应用 eval/eval_config.json 覆盖：{overrides}")

    args = parser.parse_args()

    base_url = os.environ.get("OPENAI_BASE_URL", "")
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not base_url or not api_key:
        print("缺少 OPENAI_BASE_URL / OPENAI_API_KEY，无法评测", file=sys.stderr)
        return 2

    dates = [d.strip() for d in args.dates.split(",") if d.strip()]
    print(f"载入评测样本：{', '.join(dates)}")
    papers = load_pool(args.owner, args.repo, dates)
    if args.limit:
        papers = papers[: args.limit]
    print(f"样本共 {len(papers)} 篇\n")

    judge = Judge(base_url, api_key, args.judge_model, args.workers)
    print(f"用 {args.judge_model} 生成参考标注…")
    judge_results = parallel(judge.ask, papers, args.workers)
    kept = [(index, label, raw) for index, (label, raw) in enumerate(judge_results) if label is not None]
    if not kept:
        print("参考标注全部失败，检查模型名或 API 配额", file=sys.stderr)
        return 3
    judged_papers = [papers[index] for index, _, _ in kept]
    labels = [label for _, label, _ in kept]
    raws = [raw for _, _, raw in kept]
    positives = sum(1 for label in labels if label)
    print(f"参考标注完成：{len(labels)} 篇有效，其中相关 {positives} 篇"
          f"（{positives / len(labels):.1%}）；调用失败 {judge.errors} 篇，"
          f"未解析 {judge.unparsed} 篇\n")

    config = json.loads((ROOT / "config" / "interest-filter.json").read_text(encoding="utf-8"))
    keyword_filter = InterestFilter(config)
    keywords_pred = [
        keyword_filter.match({
            "title": paper.get("title", ""),
            "summary": paper.get("summary", ""),
            "categories": paper.get("categories", []),
            "comment": paper.get("comment") or "",
        }).matched
        for paper in judged_papers
    ]
    broad_pred = [
        bool(BROAD_NET_RE.search(f"{paper.get('title','')} {paper.get('summary','')}"))
        for paper in judged_papers
    ]

    jev_probs: list[float | None] = [None] * len(judged_papers)
    jev = None
    if not args.skip_jev:
        jev = Jev(
            os.environ.get("JEV_BASE_URL", base_url),
            os.environ.get("JEV_API_KEY", api_key),
            args.jev_model,
            args.workers,
        )
        print(f"调用 {args.jev_model} 做语义判定…")
        jev_probs = parallel(jev.ask, judged_papers, args.workers)
        ok = sum(1 for value in jev_probs if value is not None)
        print(f"Jev 返回 {ok}/{len(jev_probs)} 篇，输入 {jev.input_tokens} tokens，"
              f"实付 ${jev.cost:.4f}\n")
        values = sorted(value for value in jev_probs if value is not None)
        if values:
            buckets = {
                ">=0.9": sum(1 for value in values if value >= 0.9),
                "0.7-0.9": sum(1 for value in values if 0.7 <= value < 0.9),
                "0.5-0.7": sum(1 for value in values if 0.5 <= value < 0.7),
                "0.3-0.5": sum(1 for value in values if 0.3 <= value < 0.5),
                "<0.3": sum(1 for value in values if value < 0.3),
            }
            print(f"Jev 概率分布：{buckets}（最小 {values[0]:.2f}，中位 {values[len(values)//2]:.2f}，"
                  f"最大 {values[-1]:.2f}）\n")

    rows = []
    rows.append(("keywords(当前配置)", keywords_pred, "免费"))
    rows.append(("broad_net(免费大网)", broad_pred, "免费"))

    for threshold in (0.3, 0.5, 0.7):
        pred = [value is not None and value >= threshold for value in jev_probs]
        covered = sum(1 for value in jev_probs if value is not None)
        note = f"{covered}/{len(jev_probs)} 篇有结果"
        rows.append((f"jev>= {threshold}", pred, note))

    pred_union = [
        keywords_pred[i] or (jev_probs[i] is not None and jev_probs[i] >= 0.5)
        for i in range(len(labels))
    ]
    rows.append(("keywords ∪ jev>=0.5", pred_union, "并集，召回优先"))

    print(f"{'方案':<22}{'召回':>8}{'精确':>8}{'F1':>7}{'命中':>7}{'漏掉':>7}{'误收':>7}  备注")
    report_rows = []
    for name, pred, note in rows:
        result = metrics(labels, pred)
        print(f"{name:<22}{result['recall']:>7.1%}{result['precision']:>8.1%}{result['f1']:>7.2f}"
              f"{result['tp']:>7}{result['fn']:>7}{result['fp']:>7}  {note}")
        report_rows.append({"approach": name, "note": note, **result})

    missed = []
    for index, (paper, label) in enumerate(zip(judged_papers, labels)):
        if label and not keywords_pred[index]:
            missed.append({
                "id": paper.get("id"),
                "date": paper.get("_date"),
                "title": paper.get("title"),
                "jev": jev_probs[index],
            })
    print(f"\n关键词漏掉、但参考标注认为相关的论文：{len(missed)} 篇")
    recovered = 0
    for entry in missed[:15]:
        probability = entry["jev"]
        flag = ""
        if probability is not None and probability >= 0.5:
            recovered += 1
            flag = f"  <- jev 判定相关({probability:.2f})"
        print(f"   {entry['date']} {entry['id']}  {entry['title'][:88]}{flag}")
    print(f"   （前 15 篇里，jev>=0.5 能补回 {recovered} 篇；样本共漏 {len(missed)} 篇）")

    audit = [
        {
            "id": paper.get("id"),
            "date": paper.get("_date"),
            "title": paper.get("title"),
            "judge": label,
            "judge_raw": (raw or "")[:200],
            "keywords": keywords_pred[index],
            "broad_net": broad_pred[index],
            "jev": jev_probs[index],
        }
        for index, (paper, label, raw) in enumerate(zip(judged_papers, labels, raws))
    ]

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "recall_report.json").write_text(
        json.dumps(
            {
                "dates": dates,
                "papers": len(labels),
                "positives": positives,
                "judge_model": args.judge_model,
                "judge_unparsed": judge.unparsed,
                "judge_errors": judge.errors,
                "jev_model": args.jev_model,
                "jev_cost_usd": jev.cost if jev else None,
                "jev_input_tokens": jev.input_tokens if jev else None,
                "approaches": report_rows,
                "keyword_missed_but_relevant": missed,
                "papers_detail": audit,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\n报告写入 {out_dir / 'recall_report.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
