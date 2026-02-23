import { IsEnum, IsUrl } from 'class-validator';
import { WebhookEventType } from '../enums';
import { IsSecureWebhookUrl } from '../validators/is-secure-webhook-url.validator';

export class CreateWebhookEndpointDto {
  @IsSecureWebhookUrl()
  url: string;

  @IsEnum(WebhookEventType, { each: true })
  subscribedEvents: WebhookEventType[];
}
