/**
 * Consolidate N1 — Dedup imediato, custo zero.
 *
 * Roda inline no write de memória. Duas estratégias:
 *   1. Dedup por hash de conteúdo (SHA256)
 *   2. Último fato vence por chave composta (type + scope + tags)
 *      com detecção de contradição via regex.
 */

import { createHash } from "node:crypto";
import type { Memory, MemoryType, MemoryScope } from "../types";

// ── Constantes ─────────────────────────────────────────────────────────

/** Incremento de confidence quando uma memória é reforçada */
const CONFIDENCE_INCREMENT = 0.05;

/** Confidence máxima */
const CONFIDENCE_CAP = 1.0;

// ── Regex de contradição ───────────────────────────────────────────────

/**
 * Patterns que indicam que uma nova memória CONTRADIZ uma existente.
 * Aplica-se ao texto da nova memória.
 */
const CONTRADICTION_PATTERNS: RegExp[] = [
  /\bnão\s+(?:usa|utiliza|usar|utilizar)\s+mais\b/i,
  /\bparou\s+de\s+(?:usar|utilizar)\b/i,
  /\b(?:mudou|alterou|trocou|migrou|mudamos|alteramos|trocamos|migramos)\s+(?:de\s+)?\w+\s+para\b/i,
  /\b(?:mudou|alterou|trocou|migrou)\s+para\b/i,
  /\bagora\s+(?:prefere|usa|utiliza|recomenda)\b/i,
  /\b(?:substitu[ií]do|substitui|substitu[ií]da)\s+por\b/i,
  /\b(?:em vez de|ao inv[eé]s de|no lugar de)\b/i,
  /\b(?:antes|anteriormente)\s+(?:usava|utilizava|era|estava)\b.*\b(?:agora|atualmente)\b/i,
  /\b(?:descontinuado|deprecated|obsoleto|abandonado|arquivado)\b/i,
  /\b(?:não\s+(?:funciona|serve|compat[ií]vel|recomendado|certo|correto))\b/i,
  /\b(?:nunca|jamais)\s+(?:use|usar|utilize|utilizar|fa[cç]a)\b/i,
  /\b(?:evite|evitar|evita)\s+(?:usar|utilizar)\b/i,
  /\b(?:remov|delet|apag|exclu)\w+\s+(?:do|da|o|a|os|as)\b/i,
];

/**
 * Detecta se o texto da nova memória contradiz o texto de uma existente.
 * Aplica patterns de contradição ao novo texto.
 */
export function isContradiction(newText: string, _existingText: string): boolean {
  for (const pattern of CONTRADICTION_PATTERNS) {
    if (pattern.test(newText)) {
      return true;
    }
  }
  return false;
}

// ── Normalização ───────────────────────────────────────────────────────

/** Pattern de UUID (8-4-4-4-12 hex) */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Pattern de timestamp ISO 8601 */
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;

/** Pattern de timestamp unix (10+ dígitos) */
const UNIX_TS_RE = /\b\d{10,13}\b/g;

/** Pattern de path absoluto Unix */
const ABS_PATH_RE = /(?:\s|^)(\/[^\s,;:)]+)/g;

/**
 * Normaliza conteúdo textual para hashing consistente:
 * - Remove UUIDs
 * - Remove timestamps (ISO e unix)
 * - Colapsa whitespace
 * - Normaliza line endings
 * - Lowercase
 * - Trim
 */
export function normalizeContent(text: string): string {
  let normalized = text;

  // Substitui UUIDs por placeholder
  normalized = normalized.replace(UUID_RE, "<UUID>");

  // Substitui timestamps ISO por placeholder
  normalized = normalized.replace(ISO_DATE_RE, "<DATE>");

  // Substitui timestamps unix por placeholder
  normalized = normalized.replace(UNIX_TS_RE, "<TS>");

  // Substitui paths absolutos por placeholder
  normalized = normalized.replace(ABS_PATH_RE, " <PATH>");

  // Colapsa whitespace
  normalized = normalized.replace(/\s+/g, " ");

  // Normaliza line endings
  normalized = normalized.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  return normalized.toLowerCase().trim();
}

// ── Hash ───────────────────────────────────────────────────────────────

/**
 * Gera hash SHA-256 do conteúdo normalizado.
 */
export function contentHash(text: string): string {
  const normalized = normalizeContent(text);
  return createHash("sha256").update(normalized).digest("hex");
}

// ── Chave composta ─────────────────────────────────────────────────────

/**
 * Constrói chave composta: type + scope + tags normalizadas e ordenadas.
 * Usada para "último fato vence".
 */
export function compositeKey(
  type: MemoryType,
  scope: MemoryScope,
  tags: string[]
): string {
  const normalizedTags = [...tags]
    .map((t) => t.toLowerCase().trim())
    .filter(Boolean)
    .sort()
    .join(",");

  return `${type}::${scope}::${normalizedTags}`;
}

// ── Dedup por hash ─────────────────────────────────────────────────────

export interface DedupByHashResult {
  /** A memória que deve ser persistida (new ou updated existente) */
  memory: Memory;
  /** true se é uma nova memória, false se atualizou existente */
  created: boolean;
}

/**
 * Verifica se já existe memória com mesmo content_hash no projeto.
 * Se existir: incrementa access_count, atualiza last_accessed, aumenta confidence.
 * Se não: retorna a nova memória para criação.
 */
export function dedupByHash(
  memory: Memory,
  existingByHash: Memory | null
): DedupByHashResult {
  if (existingByHash && !existingByHash.superseded_by) {
    // Reforça memória existente
    const updated: Memory = {
      ...existingByHash,
      access_count: existingByHash.access_count + 1,
      last_accessed: Date.now(),
      confidence: Math.min(
        existingByHash.confidence + CONFIDENCE_INCREMENT,
        CONFIDENCE_CAP
      ),
      // Adiciona source_ids novos
      source_ids: [
        ...new Set([...existingByHash.source_ids, ...memory.source_ids]),
      ],
    };
    return { memory: updated, created: false };
  }

  return { memory, created: true };
}

// ── Último fato vence ──────────────────────────────────────────────────

export interface LastFactWinsResult {
  /** A memória que deve ser persistida */
  memory: Memory;
  /** Se houve contradição, ID da memória que foi superada */
  supersededId?: string;
}

/**
 * Aplica regra "último fato vence" por chave composta.
 *
 * - Se não existe memória com mesma chave: cria nova.
 * - Se existe e NOVA contradiz EXISTENTE: marca existente como superseded, cria nova.
 * - Se existe e NÃO contradiz: atualiza texto e confidence da existente.
 */
export function lastFactWins(
  memory: Memory,
  existingByKey: Memory | null
): LastFactWinsResult {
  if (!existingByKey || existingByKey.superseded_by) {
    // Nenhuma memória ativa com essa chave: cria nova
    return { memory };
  }

  // Existe memória ativa com mesma chave
  if (isContradiction(memory.text, existingByKey.text)) {
    // Contradição: a nova substitui a antiga
    return {
      memory: {
        ...memory,
        // Herda access_count e source_ids acumulados
        access_count: existingByKey.access_count + 1,
        source_ids: [
          ...new Set([...existingByKey.source_ids, ...memory.source_ids]),
        ],
      },
      supersededId: existingByKey.id,
    };
  }

  // Sem contradição: atualiza a existente com o novo texto
  const updated: Memory = {
    ...existingByKey,
    text: memory.text,
    confidence: Math.min(
      existingByKey.confidence + CONFIDENCE_INCREMENT,
      CONFIDENCE_CAP
    ),
    last_accessed: Date.now(),
    access_count: existingByKey.access_count + 1,
    source_ids: [
      ...new Set([...existingByKey.source_ids, ...memory.source_ids]),
    ],
    // Atualiza hash do conteúdo novo
    content_hash: memory.content_hash,
  };

  return { memory: updated };
}

// ── Pipeline N1 completo ───────────────────────────────────────────────

export interface ConsolidateN1Input {
  /** Nova memória candidata a inserção */
  memory: Memory;
  /** Busca memória existente por hash de conteúdo */
  getByHash: (projectId: string, hash: string) => Memory | null;
  /** Busca memória existente por chave composta */
  getByKey: (key: string) => Memory | null;
}

export interface ConsolidateN1Output {
  /** Ação: "create" (nova), "update" (atualizou existente), "supersede" (substituiu) */
  action: "create" | "update" | "supersede";
  /** Memória a ser persistida */
  memory: Memory;
  /** Se action="supersede", ID da memória que foi superada */
  supersededId?: string;
}

/**
 * Pipeline N1 completo: aplica dedup por hash seguido de last-fact-wins.
 *
 * Ordem:
 *  1. Dedup por hash: se mesmo conteúdo já existe, reforça existente.
 *  2. Se não é dup por hash, verifica chave composta.
 */
export function consolidateN1(input: ConsolidateN1Input): ConsolidateN1Output {
  // Step 1: Dedup por hash
  const existingByHash = input.getByHash(
    input.memory.project_id,
    input.memory.content_hash
  );
  const hashResult = dedupByHash(input.memory, existingByHash);

  if (!hashResult.created) {
    return { action: "update", memory: hashResult.memory };
  }

  // Step 2: Last fact wins por chave composta
  const key = compositeKey(
    input.memory.type,
    input.memory.scope,
    input.memory.tags
  );
  const existingByKey = input.getByKey(key);
  const factResult = lastFactWins(hashResult.memory, existingByKey);

  if (factResult.supersededId) {
    return {
      action: "supersede",
      memory: factResult.memory,
      supersededId: factResult.supersededId,
    };
  }

  if (existingByKey && !existingByKey.superseded_by) {
    return { action: "update", memory: factResult.memory };
  }

  return { action: "create", memory: factResult.memory };
}
