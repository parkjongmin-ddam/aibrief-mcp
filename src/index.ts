/**
 * aibrief-mcp — 매일 큐레이션된 한국어 AI 브리핑을 읽기 전용 MCP 툴로 노출.
 *
 * aibrief 파이프라인(collect→rank→summarize→emit)이 만든 정본 JSON
 * (CuratedItem 배열, 하루 1파일)을 그대로 서빙한다. 요약이 이미 계산돼 있으므로
 * 요청당 LLM 호출·과금 0 — stateless·read-only.
 *
 * 데이터는 배포 번들에 넣지 않고 런타임에 공개 repo raw 에서 fetch 한다
 * (cron 이 새 일자를 push 하면 재배포 없이 바로 반영). base 는 config 로 교체 가능.
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

// ─── 도메인 상수 (aibrief SchemaEnum 미러 — schemas.py 가 정본) ───────────────
const SECTIONS = ["papers", "releases", "community", "video", "deepdive"] as const;
type Section = (typeof SECTIONS)[number];

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
  // Date.now 회피 없이 런타임(Node)에선 정상 사용 — 스크립트 하네스 제약과 무관.
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

async function getManifest(c: Config): Promise<ManifestEntry[]> {
  return fetchJson<ManifestEntry[]>(manifestUrl(c)); // 이미 내림차순
}

/** "latest"/"today" 또는 YYYY-MM-DD → 실존 일자로 해석. */
async function resolveDate(c: Config, date: string): Promise<string> {
  const m = await getManifest(c);
  if (m.length === 0) throw new Error("발행된 브리핑이 없습니다.");
  if (date === "latest" || date === "today") return m[0].date;
  if (!DATE_RE.test(date)) throw new Error(`날짜 형식 오류: ${date} (YYYY-MM-DD)`);
  if (!m.some((e) => e.date === date)) {
    throw new Error(`${date} 브리핑 없음. 최신: ${m[0].date}`);
  }
  return date;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

// ─── 서버 ────────────────────────────────────────────────────────────────────
export default function createServer({ config }: { config: Config }) {
  const server = new McpServer({ name: "aibrief", version: "0.1.0" });

  // 1) 발행된 날짜 목록.
  server.tool(
    "list_briefs",
    "발행된 일일 AI 브리핑 날짜 목록(최신순)과 각 일자 섹션별 건수를 반환한다.",
    {
      from: z.string().regex(DATE_RE).optional().describe("시작일 YYYY-MM-DD(포함)"),
      to: z.string().regex(DATE_RE).optional().describe("종료일 YYYY-MM-DD(포함)"),
      limit: z.number().int().positive().max(365).default(60).describe("최대 일수"),
    },
    async ({ from, to, limit }) => {
      let m = await getManifest(config);
      if (from) m = m.filter((e) => e.date >= from);
      if (to) m = m.filter((e) => e.date <= to);
      return json({ count: m.length, days: m.slice(0, limit) });
    }
  );

  // 2) 특정 일자 전체 브리핑.
  server.tool(
    "get_brief",
    "특정 일자의 큐레이션 브리핑 전체(모든 섹션의 CuratedItem)를 반환한다. " +
      'date 에 "latest"/"today" 를 쓰면 최신 발행일을 준다.',
    {
      date: z.string().default("latest").describe('YYYY-MM-DD 또는 "latest"/"today"'),
    },
    async ({ date }) => {
      const d = await resolveDate(config, date);
      const items = await fetchJson<CuratedItem[]>(dayUrl(config, d));
      return json({ date: d, total: items.length, items });
    }
  );

  // 3) 특정 일자·섹션만.
  server.tool(
    "get_section",
    "특정 일자의 특정 섹션(papers/releases/community/video/deepdive) 항목만 반환한다.",
    {
      date: z.string().default("latest").describe('YYYY-MM-DD 또는 "latest"/"today"'),
      section: z.enum(SECTIONS).describe("섹션"),
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

  // 4) 아카이브 전문 검색(제목/요약/why/태그 부분일치).
  server.tool(
    "search_briefs",
    "브리핑 아카이브 전체에서 키워드로 항목을 검색한다(제목 en/ko·요약·why·태그 부분일치, 대소문자 무시).",
    {
      query: z.string().min(1).describe("검색어(공백 구분 시 모든 토큰 포함, AND)"),
      section: z.enum(SECTIONS).optional().describe("섹션 한정(선택)"),
      limit: z.number().int().positive().max(100).default(20).describe("최대 결과 수"),
    },
    async ({ query, section, limit }) => {
      const rows = await fetchJson<SearchRow[]>(searchUrl(config));
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hay = (r: SearchRow) =>
        [r.title_en, r.title_ko, r.summary_ko, r.why_it_matters, r.tags.join(" ")]
          .join("\n")
          .toLowerCase();
      let hits = rows.filter((r) => {
        if (section && r.section !== section) return false;
        const h = hay(r);
        return tokens.every((t) => h.includes(t));
      });
      // search.json 은 이미 (date desc, score desc) 정렬.
      const total = hits.length;
      return json({ query, section: section ?? null, total, results: hits.slice(0, limit) });
    }
  );

  return server.server;
}
