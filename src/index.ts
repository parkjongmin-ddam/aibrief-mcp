/**
 * aibrief-mcp — 매일 큐레이션된 한국어 AI 브리핑을 읽기 전용 MCP 툴로 노출.
 *
 * aibrief 파이프라인(collect→rank→summarize→emit)이 만든 정본 JSON
 * (CuratedItem 배열, 하루 1파일)을 그대로 서빙한다. 요약이 이미 계산돼 있으므로
 * 요청당 LLM 호출·과금 0 — stateless·read-only(모든 툴 readOnlyHint).
 *
 * 데이터는 배포 번들에 넣지 않고 런타임에 공개 repo raw 에서 fetch 한다
 * (cron 이 새 일자를 push 하면 재배포 없이 바로 반영). base 는 config 로 교체 가능.
 *
 * 툴(7): list_briefs · get_brief · get_section · search_briefs
 *        · top_items · list_tags · get_stats
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ─── config (Smithery 세션 설정) ──────────────────────────────────────────────
export const configSchema = z.object({
  dataBaseUrl: z
    .string()
    .url()
    .default("https://raw.githubusercontent.com/parkjongmin-ddam/aibrief-mcp/main/data")
    .describe("정본 JSON(data/) 이 서빙되는 base URL. 포크 시 본인 repo 로 교체."),
});

type Config = z.infer<typeof configSchema>;

// ─── 도메인 상수 (aibrief schemas.py Enum 미러 — schemas.py 가 정본) ──────────
const SECTIONS = ["papers", "releases", "community", "video", "deepdive"] as const;
type Section = (typeof SECTIONS)[number];

// TagEnum 값 (schemas.py 순서).
const TAGS = ["LLM", "RAG", "에이전트", "인프라", "오픈소스"] as const;

// emit.py SECTION_HEADER 와 동일 라벨 (표시용).
const SECTION_LABEL: Record<Section, string> = {
  papers: "📄 논문",
  releases: "🚀 릴리스",
  community: "💬 커뮤니티",
  video: "🎬 영상",
  deepdive: "🔬 딥다이브",
};

// ─── 타입 (파생 뷰 — 정본은 aibrief schemas.py CuratedItem) ───────────────────
interface CuratedItem {
  id: string;
  section: Section;
  title_en: string;
  title_ko: string;
  url: string;
  sources: string[];
  summary_ko: string;
  why_it_matters: string;
  tags: string[];
  score: number;
  published_at: string;
}
interface ManifestEntry {
  date: string;
  total: number;
  counts: Partial<Record<Section, number>>;
}
interface SearchRow {
  date: string;
  id: string;
  section: Section;
  title_en: string;
  title_ko: string;
  summary_ko: string;
  why_it_matters: string;
  tags: string[];
  url: string;
  score: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── fetch 헬퍼 (경량 캐시 — 같은 URL 60초 재사용) ───────────────────────────
const _cache = new Map<string, { at: number; body: unknown }>();
const TTL_MS = 60_000;

async function fetchJson<T>(url: string): Promise<T> {
  const now = Date.now();
  const hit = _cache.get(url);
  if (hit && now - hit.at < TTL_MS) return hit.body as T;
  const res = await fetch(url, { headers: { "User-Agent": "aibrief-mcp" } });
  if (!res.ok) throw new Error(`fetch 실패 ${res.status}: ${url}`);
  const body = (await res.json()) as T;
  _cache.set(url, { at: now, body });
  return body;
}

const manifestUrl = (c: Config) => `${c.dataBaseUrl}/index.json`;
const searchUrl = (c: Config) => `${c.dataBaseUrl}/search.json`;
const dayUrl = (c: Config, date: string) => `${c.dataBaseUrl}/daily/${date}.json`;

const getManifest = (c: Config) => fetchJson<ManifestEntry[]>(manifestUrl(c)); // 내림차순
const getSearchRows = (c: Config) => fetchJson<SearchRow[]>(searchUrl(c)); // (date,score) desc

/** "latest"/"today" 또는 YYYY-MM-DD → 실존 일자로 해석. */
async function resolveDate(c: Config, date: string): Promise<string> {
  const m = await getManifest(c);
  if (m.length === 0) throw new Error("발행된 브리핑이 없습니다.");
  if (date === "latest" || date === "today") return m[0].date;
  if (!DATE_RE.test(date)) throw new Error(`날짜 형식 오류: ${date} (YYYY-MM-DD)`);
  if (!m.some((e) => e.date === date)) throw new Error(`${date} 브리핑 없음. 최신: ${m[0].date}`);
  return date;
}

const json = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
});
const RO = { readOnlyHint: true } as const; // 모든 툴 읽기 전용

// ─── 서버 ────────────────────────────────────────────────────────────────────
export default function createServer({ config }: { config: Config }) {
  const server = new McpServer({ name: "aibrief", version: "0.2.0" });

  // 1) 발행된 날짜 목록.
  server.registerTool(
    "list_briefs",
    {
      description:
        "발행된 일일 AI 브리핑 날짜 목록(최신순)과 각 일자 섹션별 건수를 반환한다.",
      inputSchema: {
        from: z.string().regex(DATE_RE).optional().describe("시작일 YYYY-MM-DD(포함)"),
        to: z.string().regex(DATE_RE).optional().describe("종료일 YYYY-MM-DD(포함)"),
        limit: z.number().int().positive().max(365).default(60).describe("최대 일수"),
      },
      annotations: RO,
    },
    async ({ from, to, limit }) => {
      let m = await getManifest(config);
      if (from) m = m.filter((e) => e.date >= from);
      if (to) m = m.filter((e) => e.date <= to);
      return json({ count: m.length, days: m.slice(0, limit) });
    }
  );

  // 2) 특정 일자 전체 브리핑.
  server.registerTool(
    "get_brief",
    {
      description:
        "특정 일자의 큐레이션 브리핑 전체(모든 섹션의 CuratedItem)를 반환한다. " +
        'date 에 "latest"/"today" 를 쓰면 최신 발행일을 준다.',
      inputSchema: {
        date: z.string().default("latest").describe('YYYY-MM-DD 또는 "latest"/"today"'),
      },
      annotations: RO,
    },
    async ({ date }) => {
      const d = await resolveDate(config, date);
      const items = await fetchJson<CuratedItem[]>(dayUrl(config, d));
      return json({ date: d, total: items.length, items });
    }
  );

  // 3) 특정 일자·섹션만.
  server.registerTool(
    "get_section",
    {
      description:
        "특정 일자의 특정 섹션(papers/releases/community/video/deepdive) 항목만 반환한다.",
      inputSchema: {
        date: z.string().default("latest").describe('YYYY-MM-DD 또는 "latest"/"today"'),
        section: z.enum(SECTIONS).describe("섹션"),
      },
      annotations: RO,
    },
    async ({ date, section }) => {
      const d = await resolveDate(config, date);
      const items = await fetchJson<CuratedItem[]>(dayUrl(config, d));
      const filtered = items.filter((it) => it.section === section);
      return json({
        date: d,
        section,
        label: SECTION_LABEL[section],
        total: filtered.length,
        items: filtered,
      });
    }
  );

  // 4) 아카이브 전문 검색(제목/요약/why/태그 부분일치 + 섹션·태그 필터).
  server.registerTool(
    "search_briefs",
    {
      description:
        "브리핑 아카이브 전체에서 키워드로 항목을 검색한다(제목 en/ko·요약·why·태그 " +
        "부분일치, 대소문자 무시). section·tag 로 좁힐 수 있다.",
      inputSchema: {
        query: z.string().min(1).describe("검색어(공백 구분 시 모든 토큰 포함, AND)"),
        section: z.enum(SECTIONS).optional().describe("섹션 한정(선택)"),
        tag: z.enum(TAGS).optional().describe("태그 한정(선택)"),
        limit: z.number().int().positive().max(100).default(20).describe("최대 결과 수"),
      },
      annotations: RO,
    },
    async ({ query, section, tag, limit }) => {
      const rows = await getSearchRows(config);
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hay = (r: SearchRow) =>
        [r.title_en, r.title_ko, r.summary_ko, r.why_it_matters, r.tags.join(" ")]
          .join("\n")
          .toLowerCase();
      const hits = rows.filter((r) => {
        if (section && r.section !== section) return false;
        if (tag && !r.tags.includes(tag)) return false;
        const h = hay(r);
        return tokens.every((t) => h.includes(t));
      });
      return json({
        query,
        section: section ?? null,
        tag: tag ?? null,
        total: hits.length,
        results: hits.slice(0, limit), // 이미 (date,score) desc 정렬
      });
    }
  );

  // 5) 최근 N개 발행일의 베스트(score 순) — 편집된 랭킹 노출.
  server.registerTool(
    "top_items",
    {
      description:
        "최근 N개 발행일 아카이브에서 점수(score) 상위 항목을 반환한다. " +
        "section 을 주면 그 섹션의 상위 목록, 안 주면 섹션별 상위 목록을 준다. " +
        "'요즘 뜨는 AI 소식' 용도. (score 밴딩이 섹션마다 달라 섹션별로 그룹핑한다.)",
      inputSchema: {
        days: z.number().int().positive().max(90).default(7).describe("최근 발행일 수"),
        section: z.enum(SECTIONS).optional().describe("섹션 한정(선택)"),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .default(10)
          .describe("섹션당(또는 전체) 최대 개수"),
      },
      annotations: RO,
    },
    async ({ days, section, limit }) => {
      const rows = await getSearchRows(config);
      const dates = [...new Set(rows.map((r) => r.date))].sort().reverse().slice(0, days);
      const dateSet = new Set(dates);
      const win = rows.filter((r) => dateSet.has(r.date));
      const byScore = (a: SearchRow, b: SearchRow) => b.score - a.score;
      const window = { days: dates.length, dates };
      if (section) {
        const items = win.filter((r) => r.section === section).sort(byScore).slice(0, limit);
        return json({ window, section, total: items.length, items });
      }
      const sections: Record<string, SearchRow[]> = {};
      for (const s of SECTIONS) {
        sections[s] = win.filter((r) => r.section === s).sort(byScore).slice(0, limit);
      }
      return json({ window, sections });
    }
  );

  // 6) 태그 목록 + 건수.
  server.registerTool(
    "list_tags",
    {
      description: "브리핑에 쓰인 태그와 각 태그의 항목 수(내림차순)를 반환한다.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      const rows = await getSearchRows(config);
      const counts = new Map<string, number>();
      for (const r of rows) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      const tags = [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count);
      return json({ tags });
    }
  );

  // 7) 아카이브 개요.
  server.registerTool(
    "get_stats",
    {
      description:
        "아카이브 개요: 총 발행일·항목수·기간(최초/최신)·섹션별/태그별 분포를 반환한다.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      const rows = await getSearchRows(config);
      const dates = [...new Set(rows.map((r) => r.date))].sort();
      const bySection: Record<string, number> = {};
      const byTag: Record<string, number> = {};
      for (const r of rows) {
        bySection[r.section] = (bySection[r.section] ?? 0) + 1;
        for (const t of r.tags) byTag[t] = (byTag[t] ?? 0) + 1;
      }
      return json({
        total_days: dates.length,
        total_items: rows.length,
        earliest: dates[0] ?? null,
        latest: dates[dates.length - 1] ?? null,
        by_section: bySection,
        by_tag: byTag,
      });
    }
  );

  return server.server;
}
