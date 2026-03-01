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
import { ApiParam, ApiResponse } from '@nestjs/swagger';

@Controller('webhooks')
@UseGuards(JwtAuthGuard)
export class WebhooksController {
  constructor(private webhooksService: WebhooksService) {}

  @Post()
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Duplicate webhook URL endpoints',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Create a webhook URL endpoint successfully',
  })
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
  @ApiParam({
    name: 'id',
    required: true,
    description: 'Should be the ID of an existing webhook endpoint',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Found 1 webhook endpoint with the given ID',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No webhook URL with the given ID found',
  })
  async findOne(@Param('id') id: string, @CurrentUser() account: Account) {
    const webhookEndpoint = await this.webhooksService.findOne(id);
    if (!webhookEndpoint || webhookEndpoint.accountId !== account.id)
      throw new NotFoundException('Webhook endpoint not found');
    return webhookEndpoint;
  }

  @Patch(':id')
  @ApiParam({
    name: 'id',
    required: true,
    description: 'Should be the ID of an existing webhook endpoint',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Updated 1 webhook endpoint with the given ID',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No webhook URL with the given ID found',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'Failed to update a webhook URL while it is being processed by workers',
  })
  async update(
    @Param('id') id: string,
    @CurrentUser() account: Account,
    @Body() dto: UpdateWebhookEndpointDto,
  ) {
    return await this.webhooksService.update(id, account.id, dto);
  }

  @Delete(':id')
  @ApiParam({
    name: 'id',
    required: true,
    description: 'Should be the ID of an existing webhook endpoint',
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Soft deleted 1 webhook endpoint with the given ID',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No webhook URL with the given ID found',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string, @CurrentUser() account: Account) {
    await this.webhooksService.delete(id, account.id);
  }
}
