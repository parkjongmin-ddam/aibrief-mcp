# aibrief-mcp

매일 큐레이션된 **한국어 AI 브리핑**을 읽기 전용 [MCP](https://modelcontextprotocol.io) 툴로
노출하는 **원격 서버**. [Cloudflare Workers](https://workers.cloudflare.com)(무상태
`createMcpHandler`)로 배포하고, [Smithery](https://smithery.ai)에 URL 을 등록해 배포·발견한다.

상위 파이프라인 [`aibrief`](https://github.com/parkjongmin-ddam/aibrief)(수집→랭킹→요약, 비공개)가
만든 **정본 JSON**을 이 repo 의 `data/`(공개 아카이브)에 미러링하고, 서버는 그것을 런타임에
읽는다. 요약이 이미 계산돼 있어 **요청당 LLM 호출·과금 0** — stateless·read-only.

## 툴 (7, 전부 read-only)

**조회** — `list_briefs` · `get_brief(date="latest")` · `get_section(date, section)` ·
`search_briefs(query, section?, tag?)`
**발견** — `top_items(days=7, section?)` · `list_tags()` · `get_stats()`

각 항목은 aibrief `CuratedItem`: `title_ko`·`summary_ko`·`why_it_matters`·`tags`·`url`·`score`.

## 구조

```
src/index.ts        # Cloudflare Worker — createMcpHandler, 7툴 (POST /mcp)
wrangler.jsonc      # Worker 설정 (compatibility_flags: nodejs_compat, var DATA_BASE_URL)
data/daily/*.json   # aibrief 정본 미러 (cron 이 매일 push)
data/index.json     # 일자 매니페스트                ← 생성물
data/search.json    # 평면 검색 인덱스               ← 생성물
scripts/build_index.py  # data/daily → index/search 재생성 (표준 라이브러리만)
```

데이터는 번들이 아니라 **런타임에 raw 에서 fetch**(base = `DATA_BASE_URL`) → cron 이 새 일자를
push 하면 재배포 없이 반영. 같은 URL 60초 캐시.

## 배포 (Cloudflare Workers)

**Git 연결(권장, 로컬 CLI 불필요)**: Cloudflare 대시보드 → Workers → **Import a repository** →
이 repo 선택 → 빌드·배포. 이후 `main` 에 코드 push 시 자동 재배포. (데이터 push 는
`[skip ci]` 커밋이라 재배포 안 함.)

**CLI**:
```bash
npm install
npx wrangler deploy      # → https://aibrief-mcp.<subdomain>.workers.dev
```

배포되면 엔드포인트 `https://.../mcp` 를 [smithery.ai/new](https://smithery.ai/new)(Publish → MCP)
의 **MCP Server URL** 에 등록 → Smithery 가 스캔해 툴 목록·Playground·호출 통계를 제공.

## 로컬 개발

```bash
npm install
npm run dev              # wrangler dev — 로컬 http://localhost:8787/mcp
```

## 인덱스 재생성 / 동기화

`data/daily/` 가 바뀌면 `python scripts/build_index.py` 로 `index.json`·`search.json` 재생성.
`aibrief` 의 `daily.yml` 이 발행 직후 그날 JSON 을 이 repo 로 push + 인덱스 재생성한다(ADR-008).

## 공개 범위 (aibrief ADR-008)

공개되는 것은 **① 서빙 코드**와 **② 브리핑 콘텐츠(JSON)** 뿐 — 수집 로직·랭킹·프롬프트·하네스는
`aibrief`(private)에 남는다.

## License

MIT (서버 코드). 브리핑 콘텐츠는 3rd-party 소스의 요약을 포함한다.
