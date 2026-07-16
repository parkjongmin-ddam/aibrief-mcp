/**
 * aibrief-mcp — Cloudflare Worker (무상태 원격 MCP 서버).
 *
 * aibrief 파이프라인이 만든 정본 JSON(공개 아카이브)을 읽기 전용 MCP 툴로 노출한다.
 * 요약이 이미 계산돼 있어 요청당 LLM 호출·과금 0. 데이터는 런타임에 공개 repo raw
 * 에서 fetch 하므로(base 는 var 로 교체 가능) cron 이 새 일자를 push 하면 재배포 없이 반영.
 *
 * 무상태(createMcpHandler): Durable Objects·세션·OAuth 불필요. 요청마다 새 McpServer
 * 인스턴스 생성(MCP SDK 1.26 보안 가드 준수). 엔드포인트: POST /mcp
 *
 * 툴(7): list_briefs · get_brief · get_section · search_briefs
 *        · top_items · list_tags · get_stats
 */
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  DATA_BASE_URL?: string;
}

const DEFAULT_BASE =
  "https://raw.githubusercontent.com/parkjongmin-ddam/aibrief-mcp/main/data";

// ─── 도메인 상수 (aibrief schemas.py Enum 미러 — schemas.py 가 정본) ──────────
const SECTIONS = ["papers", "releases", "community", "video", "deepdive"] as const;
type Section = (typeof SECTIONS)[number];
const TAGS = ["LLM", "RAG", "에이전트", "인프라", "오픈소스"] as const;
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
// 사전계산 집계(build_index.py). list_tags·get_stats 가 search.json(대용량) 대신 소비.
interface StatsDoc {
  total_days: number;
  total_items: number;
  earliest: string | null;
  latest: string | null;
  by_section: Record<string, number>;
  by_tag: Record<string, number>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── fetch 헬퍼 (isolate 스코프 캐시 — 같은 URL 60초 재사용) ──────────────────
const _cache = new Map<string, { at: number; body: unknown }>();
const TTL_MS = 60_000;

async function fetchJson<T>(url: string): Promise<T> {
  const now = Date.now();
  const hit = _cache.get(url);
  if (hit && now - hit.at < TTL_MS) return hit.body as T;
  // cf.cacheTtl: isolate 간 엣지 캐시 — 콜드 isolate마다 GitHub raw 재fetch/재파싱 방지.
  const res = await fetch(url, {
    headers: { "User-Agent": "aibrief-mcp" },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`데이터 조회 실패 (${res.status})`); // 내부 URL 비노출
  const body = (await res.json()) as T;
  _cache.set(url, { at: now, body });
  return body;
}

const json = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
});
const RO = { readOnlyHint: true } as const;

// ─── 서버 (요청당 새 인스턴스; base 클로저) ──────────────────────────────────
function createServer(base: string): McpServer {
  const u = (p: string) => `${base}/${p}`;
  const getManifest = () => fetchJson<ManifestEntry[]>(u("index.json")); // 내림차순
  const getSearchRows = () => fetchJson<SearchRow[]>(u("search.json")); // (date,score) desc
  const getStats = () => fetchJson<StatsDoc>(u("stats.json")); // 사전계산 집계(경량)
  const getDay = (d: string) => fetchJson<CuratedItem[]>(u(`daily/${d}.json`));

  async function resolveDate(date: string): Promise<string> {
    const m = await getManifest();
    if (m.length === 0) throw new Error("발행된 브리핑이 없습니다.");
    if (date === "latest" || date === "today") return m[0].date;
    if (!DATE_RE.test(date)) throw new Error(`날짜 형식 오류: ${date} (YYYY-MM-DD)`);
    if (!m.some((e) => e.date === date)) throw new Error(`${date} 브리핑 없음. 최신: ${m[0].date}`);
    return date;
  }

  const server = new McpServer({ name: "aibrief", version: "0.2.0" });

  // 1) 발행된 날짜 목록.
  server.registerTool(
    "list_briefs",
    {
      description: "발행된 일일 AI 브리핑 날짜 목록(최신순)과 각 일자 섹션별 건수를 반환한다.",
      inputSchema: {
        from: z.string().regex(DATE_RE).optional().describe("시작일 YYYY-MM-DD(포함)"),
        to: z.string().regex(DATE_RE).optional().describe("종료일 YYYY-MM-DD(포함)"),
        limit: z.number().int().positive().max(365).default(60).describe("최대 일수"),
      },
      annotations: RO,
    },
    async ({ from, to, limit }) => {
      let m = await getManifest();
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
      const d = await resolveDate(date);
      const items = await getDay(d);
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
      const d = await resolveDate(date);
      const items = (await getDay(d)).filter((it) => it.section === section);
      return json({ date: d, section, label: SECTION_LABEL[section], total: items.length, items });
    }
  );

  // 4) 아카이브 전문 검색.
  server.registerTool(
    "search_briefs",
    {
      description:
        "브리핑 아카이브 전체에서 키워드로 항목을 검색한다(제목 en/ko·요약·why·태그 " +
        "부분일치, 대소문자 무시). section·tag 로 좁힐 수 있다.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("검색어(공백 구분 시 모든 토큰 포함, AND)"),
        section: z.enum(SECTIONS).optional().describe("섹션 한정(선택)"),
        tag: z.enum(TAGS).optional().describe("태그 한정(선택)"),
        limit: z.number().int().positive().max(100).default(20).describe("최대 결과 수"),
      },
      annotations: RO,
    },
    async ({ query, section, tag, limit }) => {
      const rows = await getSearchRows();
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
        results: hits.slice(0, limit),
      });
    }
  );

  // 5) 최근 N개 발행일의 베스트(score 순).
  server.registerTool(
    "top_items",
    {
      description:
        "최근 N개 발행일 아카이브에서 점수(score) 상위 항목을 반환한다. section 을 주면 그 " +
        "섹션 상위, 안 주면 섹션별 상위. '요즘 뜨는 AI 소식' 용도(섹션별 그룹핑).",
      inputSchema: {
        days: z.number().int().positive().max(90).default(7).describe("최근 발행일 수"),
        section: z.enum(SECTIONS).optional().describe("섹션 한정(선택)"),
        limit: z.number().int().positive().max(50).default(10).describe("섹션당(또는 전체) 최대 개수"),
      },
      annotations: RO,
    },
    async ({ days, section, limit }) => {
      const rows = await getSearchRows();
      const dates = [...new Set(rows.map((r) => r.date))].sort().reverse().slice(0, days);
      const dset = new Set(dates);
      const win = rows.filter((r) => dset.has(r.date));
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
      const toTags = (byTag: Record<string, number>) =>
        Object.entries(byTag)
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count);
      try {
        return json({ tags: toTags((await getStats()).by_tag) }); // 경량 경로
      } catch {
        // stats.json 부재 시 search.json 에서 직접 집계(정확성 폴백).
        const rows = await getSearchRows();
        const counts: Record<string, number> = {};
        for (const r of rows) for (const t of r.tags) counts[t] = (counts[t] ?? 0) + 1;
        return json({ tags: toTags(counts) });
      }
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
      try {
        return json(await getStats()); // 경량 경로(사전계산)
      } catch {
        // stats.json 부재 시 search.json 에서 직접 집계(정확성 폴백).
        const rows = await getSearchRows();
        const dates = [...new Set(rows.map((r) => r.date))].sort();
        const by_section: Record<string, number> = {};
        const by_tag: Record<string, number> = {};
        for (const r of rows) {
          by_section[r.section] = (by_section[r.section] ?? 0) + 1;
          for (const t of r.tags) by_tag[t] = (by_tag[t] ?? 0) + 1;
        }
        return json({
          total_days: dates.length,
          total_items: rows.length,
          earliest: dates[0] ?? null,
          latest: dates[dates.length - 1] ?? null,
          by_section,
          by_tag,
        });
      }
    }
  );

  return server;
}

// ─── Worker 엔트리 ───────────────────────────────────────────────────────────
export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    const base = (env.DATA_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
    if (new URL(request.url).pathname === "/") {
      return new Response("aibrief MCP server — endpoint: POST /mcp\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const server = createServer(base);
    return createMcpHandler(server)(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
