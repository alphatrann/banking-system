import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateWebhookEndpointDto } from './create-webhook-endpoint.dto';

export class UpdateWebhookEndpointDto extends PartialType(
  CreateWebhookEndpointDto,
) {
  @IsBoolean()
  @IsOptional()
  active?: boolean;
}
