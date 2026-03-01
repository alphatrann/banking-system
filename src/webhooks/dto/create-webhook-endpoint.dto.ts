import { IsEnum, IsUrl } from 'class-validator';
import { WebhookEventType } from '../enums';
import { IsSecureWebhookUrl } from '../validators/is-secure-webhook-url.validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateWebhookEndpointDto {
  @IsSecureWebhookUrl()
  @ApiProperty({
    description: 'Must be a publicly accessible URL with HTTPS',
    example: ['https://example.com'],
  })
  url: string;

  @IsEnum(WebhookEventType, { each: true })
  @ApiProperty({
    description: `Must be one of the following values: ${Object.values(WebhookEventType).join(', ')}`,
    examples: Object.values(WebhookEventType),
  })
  subscribedEvents: WebhookEventType[];
}
