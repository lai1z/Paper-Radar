from typing import Literal
from pydantic import BaseModel, Field


class KeyResult(BaseModel):
    finding: str = Field(description="A concise author-reported result; preserve values, units, and comparison baseline. Never invent missing numbers.")
    setting: str = Field(description="Task, benchmark, baseline and experimental conditions explicitly reported in the abstract. State '摘要未报告' / 'Not reported in the abstract' for missing relevant conditions.")
    evidence_quote: str = Field(description="An exact contiguous excerpt copied from the original abstract supporting this result. Do not translate or paraphrase it.")


ResearchTopic = Literal["机器人策略", "感知与导航", "操作与运动", "世界模型", "规划与推理", "数据与仿真", "评测", "效率与部署"]

class Structure(BaseModel):
    tldr: str = Field(description="One or two short sentences: the problem, the core change, and the most informative supported outcome.")
    motivation: str = Field(description="What specific gap or failure motivates the work, based only on the title and abstract.")
    method: str = Field(description="Explain the input, essential mechanism, and output in plain language. Identify what changes relative to the stated baseline; do not invent implementation details.")
    result: str = Field(description="Author-reported results with task, metrics, units and baseline if available. A claim of SOTA without numbers must remain an attributed claim.")
    conclusion: str = Field(description="What this means for embodied intelligence or world models, with the limits of the evidence. No stronger conclusion than the abstract supports.")
    research_topics: list[ResearchTopic] = Field(default_factory=list, max_length=3, description="Select up to three research areas actually addressed by this paper.")
    core_method: str = Field(default="", description="One short plain-language sentence explaining the key mechanism, suitable for a paper card; avoid an acronym list.")
    key_results: list[KeyResult] = Field(default_factory=list, max_length=3, description="Up to three most useful results, each with an exact supporting abstract excerpt. Empty if the abstract states no result.")
    limitations: list[str] = Field(default_factory=list, max_length=3, description="Up to three stated limitations or important missing details. Distinguish an actual reported weakness from information merely absent from the abstract.")
