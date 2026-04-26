import { IsObject, IsOptional } from 'class-validator';

export class RebalancingRequestDto {
  @IsObject()
  @IsOptional()
  targetAllocation?: Record<string, number>;
}
