/**
 * Pure reference planning shared by the extension host and tests.
 *
 * A reference can be inserted through OpenCode's internal editor WebSocket
 * (`at_mentioned`) only when it has a file URI plus a line range that the TUI
 * can represent. The TUI's `insertFileMention` drops `lineEnd` when it equals
 * `lineStart`; a single-line selection would therefore silently become
 * "start line through end of file". We deliberately fall back to the `@...`
 * text form for that case instead of sending a wider range.
 *
 * Whole-file references (no range, or an empty/zero-width range) are always
 * emitted as the plain text form `@path`. The internal protocol has no way to
 * express "the whole file" without inventing a line range, and `@path` already
 * does that in OpenCode, so no document line count is read and no fabricated
 * range is sent. The user still confirms the mention manually.
 */

import {
  formatMention,
  rangeToMentionLines,
  type MentionLines,
  type TextRange,
} from './core';

export const MAX_REFERENCES = 200;

export interface ReferenceTarget {
  /** Exact `TextDocument.uri.toString()`; never reconstructed from an `@` string. */
  readonly uri: string;
  /** Absolute filesystem path used by the TUI protocol. */
  readonly filePath: string;
  /** Absolute workspace root used only for the text fallback mention. */
  readonly rootPath: string;
  /** Zero-based selection range, when the source supplied one. */
  readonly range?: TextRange;
}

export type ReferenceFallbackReason =
  | 'whole-file-text'
  | 'single-line'
  | 'invalid-range'
  | 'invalid-path'
  | 'missing-uri';

export interface ReferenceBridgePlan {
  readonly kind: 'bridge';
  readonly mention: string;
  readonly uri: string;
  readonly filePath: string;
  readonly lines: MentionLines;
}

export interface ReferenceTextPlan {
  readonly kind: 'text';
  /** Present when `formatMention` itself succeeded. */
  readonly mention?: string;
  readonly reason: ReferenceFallbackReason;
  readonly message: string;
}

export type ReferencePlan = ReferenceBridgePlan | ReferenceTextPlan;

function textPlan(
  result: ReturnType<typeof formatMention>,
  reason: ReferenceFallbackReason,
  message: string,
): ReferenceTextPlan {
  return {
    kind: 'text',
    ...(result.ok ? { mention: result.mention } : {}),
    reason,
    message,
  };
}

function wholeFilePlan(mention: string): ReferenceTextPlan {
  return {
    kind: 'text',
    mention,
    reason: 'whole-file-text',
    message:
      '整文件引用始终以纯文本 @路径 插入（不发送结构化行范围），' +
      '需在 OpenCode 中手动确认；扩展不会按回车/Tab。',
  };
}

/**
 * Decides between the structured bridge and the plain `@path` text form. It
 * never widens a selection or invents a whole-file range to disguise an
 * unsupported case.
 */
export function planReference(target: ReferenceTarget): ReferencePlan {
  const formatted = formatMention(target.filePath, target.rootPath, target.range);
  if (!formatted.ok) {
    const reason: ReferenceFallbackReason =
      formatted.code === 'invalid-range' ? 'invalid-range' : 'invalid-path';
    return textPlan(formatted, reason, formatted.message);
  }

  if (target.range === undefined) {
    return wholeFilePlan(formatted.mention);
  }

  const converted = rangeToMentionLines(target.range);
  if (!converted.ok) {
    return textPlan(
      formatted,
      'invalid-range',
      converted.message ?? '选区范围无效，已回退为文本引用。',
    );
  }
  const lines = converted.lines;
  if (lines === undefined) {
    return wholeFilePlan(formatted.mention);
  }

  if (target.uri.length === 0) {
    return textPlan(
      formatted,
      'missing-uri',
      '引用缺少文件 URI，未使用结构化引用，已回退为文本引用。',
    );
  }

  if (lines.startLine === lines.endLine) {
    return textPlan(
      formatted,
      'single-line',
      'OpenCode 内部 editor 协议无法表达单行范围（end 会被丢弃并扩展到文件尾），' +
        '因此单行选区只回退为文本引用，需手动确认。',
    );
  }

  return {
    kind: 'bridge',
    mention: formatted.mention,
    uri: target.uri,
    filePath: target.filePath,
    lines,
  };
}

/** Stable deduplication key that preserves the URI and range independently. */
export function referenceKey(reference: ReferenceTarget): string {
  if (reference.range === undefined) {
    return `${reference.uri}\u0000whole`;
  }
  const { start, end } = reference.range;
  return [
    reference.uri,
    start.line,
    start.character,
    end.line,
    end.character,
  ].join('\u0000');
}

/** Deduplicates references in first-seen order and enforces the count limit. */
export function uniqueReferences(
  references: readonly ReferenceTarget[],
  max = MAX_REFERENCES,
): readonly ReferenceTarget[] {
  const seen = new Set<string>();
  const result: ReferenceTarget[] = [];
  for (const reference of references) {
    if (result.length >= max) {
      break;
    }
    const key = referenceKey(reference);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(reference);
  }
  return result;
}
