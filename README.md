# aibrief-mcp

매일 큐레이션된 **한국어 AI 브리핑**(논문·릴리스·커뮤니티·영상·딥다이브)을 읽기 전용
[MCP](https://modelcontextprotocol.io) 툴로 노출하는 서버. [Smithery](https://smithery.ai)
호스티드 TypeScript 런타임으로 배포한다.

상위 파이프라인 [`aibrief`](https://github.com/parkjongmin-ddam/aibrief)(수집→랭킹→요약→발행,
비공개)가 만든 **정본 JSON**(`CuratedItem` 배열, 하루 1파일)을 그대로 서빙한다. 요약이 이미
계산돼 있어 **요청당 LLM 호출·과금 0** — stateless·read-only.

## 툴 (7, 전부 read-only)

**조회**
| 툴 | 설명 |
|----|------|
| `list_briefs(from?, to?, limit?)` | 발행된 브리핑 날짜 목록(최신순) + 섹션별 건수 |
| `get_brief(date="latest")` | 특정 일자 전체 브리핑(모든 섹션). `"latest"`/`"today"` 지원 |
| `get_section(date, section)` | 특정 일자의 한 섹션(`papers`/`releases`/`community`/`video`/`deepdive`) |
| `search_briefs(query, section?, tag?, limit?)` | 아카이브 전문 검색(제목 en/ko·요약·why·태그 부분일치, AND) |

**발견**
| 툴 | 설명 |
|----|------|
| `top_items(days=7, section?, limit?)` | 최근 N개 발행일의 점수 상위(섹션별 그룹핑) — "요즘 뜨는 AI 소식" |
| `list_tags()` | 태그 목록 + 항목 수(`LLM`/`RAG`/`에이전트`/`인프라`/`오픈소스`) |
| `get_stats()` | 아카이브 개요: 총 발행일·항목수·기간·섹션/태그별 분포 |

각 항목은 aibrief `CuratedItem` 형태: `title_ko`·`summary_ko`(2~4문장)·`why_it_matters`(1줄)·
`tags`·`url`·`score`·`published_at`. 모든 툴은 정본 JSON을 계산·필터링만 하며 **런타임 LLM 호출 0**.

## 데이터 & 갱신

서버는 데이터를 번들에 넣지 않고 **런타임에 이 repo 의 raw URL 에서 fetch** 한다
(base 는 `configSchema.dataBaseUrl`, 기본값이 이 repo 를 가리킴). 그래서 새 일자가 push 되면
**재배포 없이 즉시 반영**된다. 같은 URL 은 60초 캐시.

```
data/daily/YYYY-MM-DD.json   # aibrief 정본 복사본 (하루 1파일)
data/index.json              # 일자 매니페스트 [{date,total,counts}]  ← 생성물
data/search.json             # 평면 검색 로우                          ← 생성물
```

`index.json`·`search.json` 은 파생물이다. `data/daily/` 가 바뀌면 재생성:

```bash
python scripts/build_index.py    # 추가 의존성 0 (표준 라이브러리만)
```

### aibrief 와의 동기화

`aibrief` 는 비공개 유지(파이프라인/노하우 노출 0). 매일 정본 JSON 만 이 공개 repo 로
흘려보낸다. 권장 경로 — `aibrief` 의 `daily.yml` 발행 스텝 뒤에 한 단계 추가(ADR-006 notify 와
같은 결에서, 파이프라인 로직은 불변):

1. 그날 `data/daily/<date>.json` 을 이 repo 로 push (PAT 시크릿 사용).
2. `python scripts/build_index.py` 로 인덱스 재생성 후 커밋.

> 지금 repo 에는 검증용으로 기존 아카이브가 시드돼 있다. 자동 동기화 배선은 배포 후 다음 단계.

## 배포 (Smithery, Path A)

```bash
# 1. 이 repo 를 GitHub 에 public 으로 생성·push
gh repo create aibrief-mcp --public --source . --push

# 2. Smithery 에 등록
#    https://smithery.ai/new → 이 GitHub repo 연결 → Deploy
#    (runtime:typescript 를 인식해 클라우드에서 빌드·호스팅)
```

포크해서 쓰려면 `configSchema.dataBaseUrl` 기본값을 본인 repo raw 경로로 바꾼다.

## 로컬 개발

```bash
npm install
npm run dev      # @smithery/cli dev — 로컬 MCP 인스펙터
npm run build    # 배포 산출물 빌드
```

## 공개 범위 메모 (aibrief ADR-007)

`aibrief` 본체는 비공개다. 이 repo 가 공개하는 것은 **① 얇은 서빙 래퍼 코드**와
**② 서빙되는 브리핑 콘텐츠(JSON)** 뿐 — 수집 로직·랭킹·프롬프트·하네스는 포함하지 않는다.
"사람들이 이 MCP 를 쓴다 = 브리핑 콘텐츠를 읽는다" 는 제품 목적상 전제이며, 그 콘텐츠 공개가
이 repo 의 유일한 노출 범위다.

## License

MIT (래퍼 코드). 브리핑 콘텐츠는 3rd-party 소스의 요약을 포함한다.
