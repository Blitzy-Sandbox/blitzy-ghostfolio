import type { ChatMessage } from '@ghostfolio/common/interfaces';

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateNested
} from 'class-validator';

/**
 * Maximum permitted length, in UTF-16 code units, of any individual chat
 * message `content` string accepted by `POST /api/v1/ai/chat`.
 *
 * Rationale (defense-in-depth — QA Checkpoint 14, Issue #3):
 *
 *   The global Express body-parser limit (`useBodyParser('json', { limit:
 *   '10mb' })` in `apps/api/src/main.ts`) is the outermost cap on inbound
 *   payload size. Without a per-field cap, a single chat message can be
 *   anywhere up to that 10 MB ceiling — well beyond what any legitimate
 *   conversational turn requires and large enough to (a) inflate Anthropic
 *   API token costs, (b) prolong upstream `messages.stream(...)` round
 *   trips, and (c) consume server CPU during JSON parse + class-validator
 *   traversal before the request ever reaches the service layer.
 *
 *   `4000` was chosen as a safe upper bound for natural-language portfolio
 *   questions (well above the typical question length of < 500 characters)
 *   while remaining one to two orders of magnitude below the 10 MB body
 *   parser limit. It is intentionally a conservative ceiling — increase
 *   only after measuring real-world chat-content distributions.
 */
const CHAT_MESSAGE_CONTENT_MAX_LENGTH = 4000;

export class ChatMessageDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(CHAT_MESSAGE_CONTENT_MAX_LENGTH)
  content: string;

  @IsIn(['user', 'assistant'] as ChatMessage['role'][])
  role: ChatMessage['role'];
}

export class ChatRequestDto {
  @ArrayMaxSize(5)
  @ArrayMinSize(1)
  @IsArray()
  @Type(() => ChatMessageDto)
  @ValidateNested({ each: true })
  messages: ChatMessageDto[];
}
