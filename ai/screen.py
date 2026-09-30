#!/usr/bin/env python3
"""Jev 语义闸门：在调用昂贵的总结模型之前，先判断论文是否属于目标领域。

设计要点：
- 逐篇把标题和摘要交给 TypeSafe Jev（OpenRouter 的 System One / Decisions 接口），
  它返回一个“属于该领域”的概率，而不是生成文本，因此输出几乎不产生费用。
- 判定失败时 fail-open：保留论文，避免接口抖动导致整天内容丢失。
- 把全部论文的分数写到外部文件（默认 /tmp），方便事后调整阈值或复盘，不污染 data 分支。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# 兜底定义：正常情况下从 config/research-scope.json 读取，改那份文件即可调整口径
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

INSTRUCTIONS = "Does this arXiv paper belong to the reader's research area described in the criteria?"
DEFAULT_MODEL = "typesafe/jev-1.13"
DEFAULT_THRESHOLD = 0.7
DEFAULT_MAX_PAPERS = 50


def load_scope() -> tuple[str, str, str]:
    """读取领域定义；返回 (true 描述, false 描述, 来源路径)。"""
    candidates = []
    env_path = os.environ.get("RESEARCH_SCOPE_CONFIG")
    if env_path:
        candidates.append(Path(env_path))
    candidates.append(Path("../config/research-scope.json"))
    candidates.append(Path(__file__).resolve().parent.parent / "config" / "research-scope.json")
    for path in candidates:
        try:
            if path.exists():
                data = json.loads(path.read_text(encoding="utf-8"))
                if data.get("true") and data.get("false"):
                    return str(data["true"]), str(data["false"]), str(path)
        except Exception as error:  # noqa: BLE001
            print(f"读取领域定义失败 {path}: {error}", file=sys.stderr)
    return DOMAIN_TRUE, DOMAIN_FALSE, "(内置兜底定义)"


def ask_jev(
    item: dict,
    base_url: str,
    api_key: str,
    model: str,
    criteria: dict,
    attempts: int = 3,
) -> tuple[float | None, str]:
    payload = {
        "model": model,
        "state": {
            "title": item.get("title", ""),
            "abstract": item.get("summary", ""),
            "categories": ", ".join(item.get("categories") or []),
        },
        "questions": {
            "in_domain": {
                "type": "noul",
                "instructions": INSTRUCTIONS,
                "criteria": criteria,
            }
        },
    }
    request = urllib.request.Request(
        base_url.rstrip("/") + "/systemone",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    last_error = ""
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                data = json.load(response)
            answer = (data.get("answers") or {}).get("in_domain") or {}
            value = answer.get("noul")
            usage = data.get("usage") or {}
            return (
                float(value) if value is not None else None,
                f"ok:{int(usage.get('input_tokens') or 0)}:{float(usage.get('cost') or 0):.8f}",
            )
        except Exception as error:  # noqa: BLE001
            last_error = f"{type(error).__name__}: {error}"
            if attempt + 1 < attempts:
                time.sleep(min(2 ** (attempt + 1), 10))
    print(f"  screen error for {item.get('id')}: {last_error}", file=sys.stderr)
    return None, f"error:{last_error[:120]}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True, help="当日抓取结果 jsonl（会被筛选后的结果覆盖）")
    parser.add_argument("--scores-out", default="", help="全部论文的 Jev 分数，写到 data 目录之外")
    parser.add_argument("--threshold", default="", help="概率下限，默认 0.7")
    parser.add_argument("--max-papers", default="", help=f"每天最多保留多少篇（按分数取前 N），默认 {DEFAULT_MAX_PAPERS}，0 表示不限制")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--model", default=os.environ.get("JEV_MODEL", DEFAULT_MODEL))
    args = parser.parse_args()

    threshold = float(args.threshold) if str(args.threshold).strip() else DEFAULT_THRESHOLD
    max_papers = int(args.max_papers) if str(args.max_papers).strip() else DEFAULT_MAX_PAPERS
    base_url = os.environ.get("JEV_BASE_URL") or os.environ.get("OPENAI_BASE_URL") or "https://openrouter.ai/api/v1"
    api_key = os.environ.get("JEV_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""
    if not api_key:
        print("缺少 JEV_API_KEY / OPENAI_API_KEY，跳过闸门并保留全部论文", file=sys.stderr)
        return 0

    data_path = Path(args.data)
    domain_true, domain_false, scope_source = load_scope()
    criteria = {"true": domain_true, "false": domain_false}
    papers = [json.loads(line) for line in data_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    print(
        f"Jev 闸门：{len(papers)} 篇候选，模型 {args.model}，阈值 {threshold}，"
        f"每日上限 {max_papers if max_papers > 0 else '不限'} 篇，领域定义来自 {scope_source}",
        file=sys.stderr,
    )

    results: list[tuple[float | None, str]] = []
    if args.workers > 1 and len(papers) > 1:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            results = list(pool.map(lambda item: ask_jev(item, base_url, api_key, args.model, criteria), papers))
    else:
        results = [ask_jev(item, base_url, api_key, args.model, criteria) for item in papers]

    failed = 0
    tokens = 0
    cost = 0.0
    for _, (_, note) in zip(papers, results):
        if note.startswith("ok:"):
            _, token_text, cost_text = note.split(":", 2)
            tokens += int(token_text)
            cost += float(cost_text)
        elif note.startswith("error:"):
            failed += 1

    # 先按分数排序，再统一决定每篇的最终去向，保证审计文件里的标记就是最终结论
    eligible = sorted(
        (
            (score, item)
            for item, (score, _) in zip(papers, results)
            if score is not None and score >= threshold
        ),
        key=lambda pair: -pair[0],
    )
    fail_open_items = [item for item, (score, _) in zip(papers, results) if score is None]
    if max_papers > 0 and len(eligible) > max_papers:
        kept_scored = eligible[:max_papers]
        over_limit = {item["id"] for _, item in eligible[max_papers:]}
    else:
        kept_scored = eligible
        over_limit = set()
    kept = [item for _, item in kept_scored] + fail_open_items
    kept_ids = {item["id"] for item in kept}
    cutoff = kept_scored[-1][0] if kept_scored else None

    rejected: list[dict] = []
    scored_lines = []
    for item, (score, _) in zip(papers, results):
        record = dict(item)
        record["jev_score"] = score
        if score is None:
            record["screen"] = "fail_open"
        elif item["id"] in kept_ids:
            record["screen"] = "kept"
        elif item["id"] in over_limit:
            record["screen"] = "over_daily_limit"
        else:
            record["screen"] = "rejected"
        scored_lines.append(json.dumps(record, ensure_ascii=False))
        if record["screen"] in ("rejected", "over_daily_limit"):
            rejected.append(record)

    if args.scores_out:
        scores_path = Path(args.scores_out)
        scores_path.parent.mkdir(parents=True, exist_ok=True)
        scores_path.write_text("\n".join(scored_lines) + "\n", encoding="utf-8")
        print(f"全部分数写入 {scores_path}", file=sys.stderr)

    temporary = data_path.with_suffix(data_path.suffix + ".tmp")
    temporary.write_text("\n".join(json.dumps(item, ensure_ascii=False) for item in kept) + "\n", encoding="utf-8")
    os.replace(temporary, data_path)

    print(
        f"Jev 闸门完成：阈值 {threshold}、上限 {max_papers if max_papers > 0 else '不限'} -> 保留 {len(kept)} 篇"
        + (f"（最低分 {cutoff:.3f}）" if cutoff is not None else "")
        + f"，过滤 {len(rejected)} 篇，判定失败 {failed} 篇（已按保留处理）；"
        f"输入 {tokens} tokens，费用 ${cost:.4f}",
        file=sys.stderr,
    )
    if not kept:
        print("闸门后没有剩余论文，为避免清空当日数据，改为保留全部候选", file=sys.stderr)
        data_path.write_text("\n".join(json.dumps(item, ensure_ascii=False) for item in papers) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
