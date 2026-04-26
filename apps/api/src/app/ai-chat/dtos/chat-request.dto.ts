import type { ChatMessage } from '@ghostfolio/common/interfaces';

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsString,
  ValidateNested
} from 'class-validator';

export class ChatMessageDto {
  @IsNotEmpty()
  @IsString()
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
