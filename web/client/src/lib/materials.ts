/** 面试材料（面试档案）的前端数据模型与接口。 */

import { json, request } from "@/lib/http";

export type InterviewLanguage = "zh" | "en";
export type CardStatus = "pending" | "generating" | "ready" | "failed";
export type CardSource = "ai" | "manual";

export type CardBodyKey =
  | "facts"
  | "defense"
  | "pushback"
  | "boundaries"
  | "depth"
  | "nextQuestion";

export const CARD_BODY_KEYS: CardBodyKey[] = [
  "facts",
  "defense",
  "pushback",
  "boundaries",
  "depth",
  "nextQuestion",
];

export const CARDS_MAX = 10;

export interface MaterialSection {
  original: string;
  content: string;
  updatedAt: string | null;
}

export interface ExperienceCard {
  slug: string;
  name: string;
  description: string;
  body: Record<CardBodyKey, string>;
  source: CardSource;
  status: CardStatus;
  error: string | null;
  sourceRevision: number;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface InterviewProfile {
  id: string;
  name: string;
  language: InterviewLanguage;
  resume: MaterialSection;
  jobDescription: MaterialSection;
  cards: ExperienceCard[];
  /** 完善经历卡的补全清单：{ [cardSlug]: { [dimension]: { q, a, applied } } }。 */
  coachSlots?: CoachSlots;
  materialsRevision: number;
  createdAt: string;
  updatedAt: string;
}

/** 补全清单的固定维度，顺序就是界面上的顺序。 */
export const COACH_DIMENSIONS = [
  "scale",
  "actions",
  "team",
  "mechanism",
  "verification",
  "reflection",
] as const;

export type CoachDimension = (typeof COACH_DIMENSIONS)[number];

export interface CoachSlot {
  /** AI 针对这张卡出的问题，生成一次后一直复用。 */
  q: string;
  /** 候选人的回答；空字符串表示还没答。 */
  a: string;
  /** 这条回答是否已经合并进经历卡。 */
  applied: boolean;
}

export type CoachSlots = Record<string, Record<string, CoachSlot>>;

export interface ProfileSummary {
  id: string;
  name: string;
  language: InterviewLanguage;
  updatedAt: string;
  cardCount: number;
  readyCardCount: number;
  hasResume: boolean;
  hasJobDescription: boolean;
  materialsRevision: number;
}

export interface StorageInfo {
  dataDir: string;
  file: string;
  exists: boolean;
  fileExists: boolean;
  /** 向量模型缓存目录（独立于数据目录）。 */
  modelDir?: string;
  /** modelDir 是否是用户显式设置的；false 表示跟随数据目录。 */
  modelDirCustom?: boolean;
}

export type MaterialKind = "resume" | "jobDescription";

export interface ProfilePatch {
  name?: string;
  language?: InterviewLanguage;
  resume?: Partial<MaterialSection>;
  jobDescription?: Partial<MaterialSection>;
  cards?: ExperienceCard[];
  coachSlots?: CoachSlots;
}

export async function listProfiles(): Promise<ProfileSummary[]> {
  const data = await request<{ profiles: ProfileSummary[] }>("/api/profiles");
  return data.profiles;
}

export async function createProfile(name: string): Promise<InterviewProfile> {
  return request<InterviewProfile>("/api/profiles", json("POST", { name }));
}

export async function getProfile(id: string): Promise<InterviewProfile> {
  return request<InterviewProfile>(`/api/profiles/${id}`);
}

export async function patchProfile(
  id: string,
  patch: ProfilePatch,
): Promise<InterviewProfile> {
  return request<InterviewProfile>(`/api/profiles/${id}`, json("PATCH", patch));
}

export async function deleteProfile(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/profiles/${id}`, { method: "DELETE" });
}

export async function consolidateMaterial(
  id: string,
  kind: MaterialKind,
  content: string,
  language: InterviewLanguage,
): Promise<string> {
  const data = await request<{ content: string }>(
    `/api/profiles/${id}/consolidate`,
    json("POST", { kind, content, language }),
  );
  return data.content;
}

export async function planSkills(id: string): Promise<InterviewProfile> {
  return request<InterviewProfile>(
    `/api/profiles/${id}/skills/plan`,
    json("POST", {}),
  );
}

export async function generateSkill(
  id: string,
  slug: string,
): Promise<ExperienceCard> {
  return request<ExperienceCard>(
    `/api/profiles/${id}/skills/${encodeURIComponent(slug)}/generate`,
    json("POST", {}),
  );
}

/** 取一张卡的补全清单；第一次调用会让 AI 出 6 个问题并落盘。返回整张表。 */
export async function coachQuestions(
  id: string,
  slug: string,
): Promise<CoachSlots> {
  const data = await request<{ coachSlots: CoachSlots }>(
    `/api/profiles/${id}/coach/questions`,
    json("POST", { slug }),
  );
  return data.coachSlots ?? {};
}

/** 保存一格回答（纯本地写盘，不经过模型）。返回整张表。 */
export async function coachAnswer(
  id: string,
  slug: string,
  dimension: CoachDimension,
  answer: string,
): Promise<CoachSlots> {
  const data = await request<{ coachSlots: CoachSlots }>(
    `/api/profiles/${id}/coach/answer`,
    json("POST", { slug, dimension, answer }),
  );
  return data.coachSlots ?? {};
}

/** 把还没写回的回答合并进经历卡，返回整份档案。 */
export async function coachWriteBack(
  id: string,
  slug: string,
): Promise<InterviewProfile> {
  return request<InterviewProfile>(
    `/api/profiles/${id}/coach/apply`,
    json("POST", { slug }),
  );
}

export async function fetchStorage(): Promise<StorageInfo> {
  return request<StorageInfo>("/api/storage");
}

export async function saveStorage(
  dataDir: string,
  migrate = true,
): Promise<StorageInfo> {
  return request<StorageInfo>("/api/storage", json("PUT", { dataDir, migrate }));
}

export async function openStorageFolder(): Promise<void> {
  await request<{ ok: boolean }>("/api/storage/open", { method: "POST" });
}

/** 弹出系统文件夹选择器；用户取消时返回空串。 */
export async function pickFolder(initial: string): Promise<string> {
  if (typeof window !== "undefined" && window.desktop?.storage) {
    return window.desktop.storage.pickDirectory(initial);
  }
  const data = await request<{ path: string }>(
    "/api/storage/pick",
    json("POST", { path: initial }),
  );
  return data.path ?? "";
}

/** 只改模型缓存目录，数据目录不动。 */
export async function saveModelDir(modelDir: string): Promise<StorageInfo> {
  return request<StorageInfo>("/api/storage", json("PUT", { modelDir }));
}

/**
 * 一次提交数据目录和模型目录。modelDir 传空串表示「跟随数据目录」；
 * dataDir 传空串表示不改数据目录（只用于分开设置时）。
 */
export async function saveStoragePaths(
  dataDir: string,
  modelDir: string,
  migrate = true,
): Promise<StorageInfo> {
  return request<StorageInfo>(
    "/api/storage",
    json("PUT", { dataDir, modelDir, migrate }),
  );
}

/** 空卡片（手动新增时用）。 */
export function emptyCard(
  slug: string,
  name: string,
  sourceRevision: number,
  position: number,
): ExperienceCard {
  const now = new Date().toISOString();
  return {
    slug,
    name,
    description: "",
    body: {
      facts: "",
      defense: "",
      pushback: "",
      boundaries: "",
      depth: "",
      nextQuestion: "",
    },
    source: "manual",
    status: "ready",
    error: null,
    sourceRevision,
    position,
    createdAt: now,
    updatedAt: now,
  };
}

export function sortCards(cards: ExperienceCard[]): ExperienceCard[] {
  return [...cards].sort((a, b) => a.position - b.position);
}

export function isCardStale(
  card: ExperienceCard,
  materialsRevision: number,
): boolean {
  return card.source === "ai" && card.status === "ready" &&
    card.sourceRevision !== materialsRevision;
}
