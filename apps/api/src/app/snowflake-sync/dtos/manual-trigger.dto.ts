import { IsISO8601, IsOptional, IsString } from 'class-validator';

export class ManualTriggerDto {
  @IsISO8601()
  @IsOptional()
  date?: string;

  @IsOptional()
  @IsString()
  userId?: string;
}
