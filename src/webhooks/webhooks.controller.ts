import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { UpdateWebhookEndpointDto } from './dto/update-webhook-endpoint.dto';
import { JwtAuthGuard } from '../auth/guards';
import { CurrentUser } from '../users/decorators';
import type { Account } from '@prisma/client';

@Controller('webhooks')
@UseGuards(JwtAuthGuard)
export class WebhooksController {
  constructor(private webhooksService: WebhooksService) {}

  @Post()
  create(
    @CurrentUser() account: Account,
    @Body() dto: CreateWebhookEndpointDto,
  ) {
    return this.webhooksService.create(account.id, dto);
  }

  @Get()
  findAll(@CurrentUser() account: Account) {
    return this.webhooksService.findAll(account.id);
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() account: Account) {
    const webhookEndpoint = await this.webhooksService.findOne(id);
    if (!webhookEndpoint || webhookEndpoint.accountId !== account.id)
      throw new NotFoundException('Webhook endpoint not found');
    return webhookEndpoint;
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @CurrentUser() account: Account,
    @Body() dto: UpdateWebhookEndpointDto,
  ) {
    return await this.webhooksService.update(id, account.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string, @CurrentUser() account: Account) {
    await this.webhooksService.delete(id, account.id);
  }
}
