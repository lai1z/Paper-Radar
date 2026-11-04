import os
import json
import sys
import re
import requests
import hashlib
from pathlib import Path
from checkpoint import process_with_checkpoint
from digest import grounded_digest, migrate_pending, defer_items
from paper_history import canonical_id, fingerprint, is_successful, read_records, successful_fingerprints
from recovery import prune_published_pending, unpublished_successes
from copy import deepcopy
from provenance import assert_source_preserved
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict
from queue import Queue
from threading import Lock
import dotenv
import argparse
from tqdm import tqdm

import langchain_core.exceptions
from langchain_openai import ChatOpenAI
from langchain.prompts import (
    ChatPromptTemplate,
    SystemMessagePromptTemplate,
    HumanMessagePromptTemplate,
)
from structure import Structure
from content_filter import is_sensitive
from runtime import build_chat_openai_kwargs, raise_if_processing_failed

if os.path.exists('.env'):
    dotenv.load_dotenv()
SCRIPT_DIR = Path(__file__).resolve().parent
template = (SCRIPT_DIR / "template.txt").read_text(encoding="utf-8")
system = (SCRIPT_DIR / "system.txt").read_text(encoding="utf-8")

def parse_args():
    """解析命令行参数"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=str, required=True, help="jsonline data file")
    parser.add_argument("--max_workers", type=int, default=1, help="Maximum number of parallel workers")
    parser.add_argument("--max_papers", type=int, default=50, help="Maximum daily AI papers including pending retries")
    parser.add_argument("--published-data", type=Path, help="Previously published data for this same date, if any")
    parser.add_argument("--history-dir", type=Path, default=os.environ.get("PAPER_HISTORY_DIR"),
                        help="Successful publication history, including prior days")
    return parser.parse_args()

def process_single_item(chain, item: Dict, language: str) -> Dict:
    # Generated fields annotate a copy; the caller's source record is immutable.
    source = deepcopy(item)
    item = deepcopy(item)
    def check_github_code(content: str) -> Dict:
        """提取并验证 GitHub 链接"""
        code_info = {}

        # 1. 优先匹配 github.com/owner/repo 格式
        github_pattern = r"https?://github\.com/([a-zA-Z0-9-_]+)/([a-zA-Z0-9-_\.]+)"
        match = re.search(github_pattern, content)
        
        if match:
            owner, repo = match.groups()
            # 清理 repo 名称，去掉可能的 .git 后缀或末尾的标点
            repo = repo.rstrip(".,)")
            if repo.endswith(".git"):
                repo = repo[:-4]
            
            full_url = f"https://github.com/{owner}/{repo}"
            code_info["code_url"] = full_url
            
            # 尝试调用 GitHub API 获取信息
            github_token = os.environ.get("TOKEN_GITHUB")
            headers = {"Accept": "application/vnd.github.v3+json"}
            if github_token:
                headers["Authorization"] = f"token {github_token}"
            
            try:
                api_url = f"https://api.github.com/repos/{owner}/{repo}"
                resp = requests.get(api_url, headers=headers, timeout=5)
                if resp.status_code == 200:
                    data = resp.json()
                    code_info["code_stars"] = data.get("stargazers_count", 0)
                    code_info["code_last_update"] = data.get("pushed_at", "")[:10]
            except Exception:
                # API 调用失败不影响主流程
                pass
            return code_info

        # 2. 如果没有 github.com，尝试匹配 github.io
        github_io_pattern = r"https?://[a-zA-Z0-9-_]+\.github\.io(?:/[a-zA-Z0-9-_\.]+)*"
        match_io = re.search(github_io_pattern, content)
        
        if match_io:
            url = match_io.group(0)
            # 清理末尾标点
            url = url.rstrip(".,)")
            code_info["code_url"] = url
            # github.io 不进行 star 和 update 判断
                
        return code_info

    # 检查 summary 字段
    if is_sensitive(item.get("summary", "")):
        return None

    # 检测代码可用性
    code_info = check_github_code(item.get("summary", ""))
    if code_info:
        item.update(code_info)

    """处理单个数据项"""
    # Default structure with meaningful fallback values
    default_ai_fields = {
        "tldr": "Summary generation failed",
        "motivation": "Motivation analysis unavailable",
        "method": "Method extraction failed",
        "result": "Result analysis unavailable",
        "conclusion": "Conclusion extraction failed"
    }
    
    try:
        response: Structure = chain.invoke({
            "language": language,
            "title": item.get('title', ''),
            "content": item['summary']
        })
        item['AI'] = grounded_digest(response.model_dump(), item.get('summary', ''), language)
    except Exception as e:
        raise RuntimeError(f"AI response failed for {item.get('id', 'unknown')}: {e}") from e

    # Final validation to ensure all required fields exist
    for field in default_ai_fields.keys():
        if field not in item['AI']:
            item['AI'][field] = default_ai_fields[field]

    # Check the digest together; added structured fields must not multiply requests.
    generated_text = json.dumps({key: value for key, value in item.get("AI", {}).items()
                                 if key not in ("source", "digest_version")}, ensure_ascii=False)
    if is_sensitive(generated_text):
        return None
    assert_source_preserved(source, item)
    return item

def process_all_items(data: List[Dict], model_name: str, language: str, max_workers: int, max_papers: int = 50,
                      exclude_ids=(), priority_ids=(), published_fingerprints=None,
                      history_fingerprints=None) -> List[Dict]:
    """并行处理所有数据项"""
    if max_papers < 0:
        raise ValueError("max_papers must be nonnegative")
    signature = hashlib.sha256(
        json.dumps([model_name, language, os.environ.get("OPENAI_BASE_URL", ""),
                    system, template, (SCRIPT_DIR / "structure.py").read_text(encoding="utf-8")],
                   ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    checkpoint_dir = SCRIPT_DIR.parent / ".ai-checkpoints"
    if history_fingerprints is not None:
        removed = prune_published_pending(checkpoint_dir, history_fingerprints)
        if removed:
            print(f"Removed {removed} already-published papers from the retry queue", file=sys.stderr)
        data = [row for row in data if fingerprint(row) not in history_fingerprints]
    migrate_pending(checkpoint_dir, signature)
    published_fingerprints = published_fingerprints or {}
    active_path = checkpoint_dir / f"{signature}.json"
    queued = json.loads(active_path.read_text(encoding="utf-8"))["pending"] if active_path.exists() else {}
    latest = {**queued, **{item['id']: item for item in data}}
    recovered = []
    if history_fingerprints is not None:
        recovered = [row for row in unpublished_successes(checkpoint_dir, history_fingerprints, latest.values())
                     if canonical_id(row) not in exclude_ids][:max_papers]
    recovered_ids = {canonical_id(row) for row in recovered}
    exclude_ids = set(exclude_ids) | recovered_ids
    remaining = max_papers - len(recovered)
    if recovered:
        print(f"Recovered {len(recovered)} completed but unpublished digests without new AI requests", file=sys.stderr)
    defer_ids = {canonical_id(item) for item in latest.values()
                 if canonical_id(item) in published_fingerprints
                 and fingerprint(item) != published_fingerprints[canonical_id(item)]}
    if remaining == 0:
        defer_items(data, checkpoint_dir, signature, exclude_ids, defer_ids)
        print('Daily publication budget is full; selected papers remain queued', file=sys.stderr)
        return recovered
    llm = ChatOpenAI(
        **build_chat_openai_kwargs(
            model_name=model_name,
            base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
            api_key=os.environ.get("OPENAI_API_KEY", ""),
        )
    ).with_structured_output(Structure, method="function_calling")

    print('Connect to:', model_name, file=sys.stderr)
    
    prompt_template = ChatPromptTemplate.from_messages([
        SystemMessagePromptTemplate.from_template(system),
        HumanMessagePromptTemplate.from_template(template=template)
    ])

    chain = prompt_template | llm
    
    return recovered + process_with_checkpoint(
        data, lambda item: process_single_item(chain, item, language),
        checkpoint_dir, signature, workers=max_workers, max_items=remaining,
        exclude_ids=exclude_ids, priority_ids=priority_ids, defer_ids=defer_ids,
    )


def main():
    args = parse_args()
    model_name = os.environ.get("MODEL_NAME", "gpt-4o-mini")
    language = os.environ.get("LANGUAGE", 'Chinese')
    if args.max_papers < 1:
        raise ValueError("--max_papers must be positive")
    published = read_records(args.published_data) if args.published_data else []
    completed_ids = {canonical_id(item) for item in published if is_successful(item)}
    published_fingerprints = {canonical_id(item): fingerprint(item) for item in published if is_successful(item)}
    retry_ids = {canonical_id(item) for item in published if item.get("AI_status") == "failed"}
    budget = max(0, args.max_papers - len(completed_ids))
    history_fingerprints = None
    if args.history_dir:
        publication_date = Path(args.data).name[:10]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", publication_date):
            raise ValueError("History reconciliation requires a dated input filename")
        history_fingerprints, _ = successful_fingerprints(args.history_dir, publication_date)

    # 检查并删除目标文件
    target_file = args.data.replace('.jsonl', f'_AI_enhanced_{language}.jsonl')
    # 读取数据
    data = []
    with open(args.data, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                data.append(json.loads(line))

    # 去重
    seen_ids = set()
    unique_data = []
    for item in data:
        if item['id'] not in seen_ids:
            seen_ids.add(item['id'])
            unique_data.append(item)

    data = unique_data
    print('Open:', args.data, file=sys.stderr)

    # 长尾论文（Jev 判定相关度中等）只收录、不调用总结模型
    raw_items = [item for item in data if item.get("skip_ai")]
    to_summarize = [item for item in data if not item.get("skip_ai")]
    if raw_items:
        print(f'其中 {len(raw_items)} 篇为长尾仅收录，不调用 AI', file=sys.stderr)

    # 并行处理需要总结的论文
    processed_data = process_all_items(
        to_summarize,
        model_name,
        language,
        args.max_workers,
        max_papers=budget,
        exclude_ids=completed_ids,
        priority_ids=retry_ids,
        published_fingerprints=published_fingerprints,
        history_fingerprints=history_fingerprints,
    )

    # 检查点缓存里可能没有后来新增的字段，按 id 从当日数据回填（例如相关度分数）
    metadata = {item["id"]: item for item in data}
    for item in processed_data:
        if item is None:
            continue
        source = metadata.get(item.get("id"))
        if source and "relevance" in source:
            item["relevance"] = source["relevance"]
    
    # 保存结果
    temporary_file = target_file + ".tmp"
    with open(temporary_file, "w", encoding="utf-8") as f:
        for item in processed_data:
            if item is not None:
                f.write(json.dumps(item) + "\n")
        for item in raw_items:
            item = dict(item)
            item.pop("skip_ai", None)
            item["AI_status"] = "raw"
            f.write(json.dumps(item) + "\n")
    os.replace(temporary_file, target_file)

if __name__ == "__main__":
    main()
