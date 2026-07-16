"""data/daily/*.json → data/index.json + data/search.json 재생성.

aibrief 정본(CuratedItem 배열)을 소비하는 얇은 파생물이다. 런타임(MCP 서버)이
매 요청마다 개별 일자 파일을 긁지 않도록, 목록/검색용 경량 인덱스를 미리 만든다.

- index.json  : 일자 매니페스트 [{date, total, counts{section:n}}] (내림차순).
- search.json : 평면 검색 로우 [{date, id, section, title_en, title_ko,
                summary_ko, why_it_matters, tags, url, score}].

추가 의존성 0 (표준 라이브러리만) — aibrief 철학과 동일. cron 이 일자 JSON 을
push 한 뒤 이 스크립트를 돌려 인덱스를 갱신한다(README §동기화).
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DAILY = ROOT / "data" / "daily"
INDEX = ROOT / "data" / "index.json"
SEARCH = ROOT / "data" / "search.json"
STATS = ROOT / "data" / "stats.json"

# search.json 에 실을 필드 (렌더/매칭에 필요한 것만; score 는 랭킹 참고용).
_SEARCH_FIELDS = (
    "id",
    "section",
    "title_en",
    "title_ko",
    "summary_ko",
    "why_it_matters",
    "tags",
    "url",
    "score",
)


def build() -> tuple[int, int]:
    manifest: list[dict] = []
    rows: list[dict] = []

    for path in sorted(DAILY.glob("*.json")):
        date = path.stem  # YYYY-MM-DD
        items = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(items, list):
            print(f"::warning:: {path.name} 최상위가 배열이 아님 — skip")
            continue

        counts = Counter(it.get("section", "?") for it in items)
        manifest.append(
            {"date": date, "total": len(items), "counts": dict(sorted(counts.items()))}
        )
        for it in items:
            row = {"date": date, **{k: it.get(k) for k in _SEARCH_FIELDS}}
            rows.append(row)

    # 최신일이 먼저.
    manifest.sort(key=lambda d: d["date"], reverse=True)
    rows.sort(key=lambda r: (r["date"], r.get("score") or 0.0), reverse=True)

    # 사전계산 집계 — 런타임 list_tags·get_stats 가 search.json(대용량) 대신 소비.
    by_section: Counter[str] = Counter()
    by_tag: Counter[str] = Counter()
    for r in rows:
        by_section[r["section"]] += 1
        for t in r.get("tags") or []:
            by_tag[t] += 1
    all_dates = sorted({r["date"] for r in rows})
    stats = {
        "total_days": len(manifest),
        "total_items": len(rows),
        "earliest": all_dates[0] if all_dates else None,
        "latest": all_dates[-1] if all_dates else None,
        "by_section": dict(sorted(by_section.items())),
        "by_tag": dict(by_tag.most_common()),  # 건수 내림차순
    }

    INDEX.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    SEARCH.write_text(
        json.dumps(rows, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    STATS.write_text(
        json.dumps(stats, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return len(manifest), len(rows)


if __name__ == "__main__":
    days, items = build()
    print(f"index.json: {days}일 / search.json: {items}건")
