import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { UpdateWebhookEndpointDto } from './dto/update-webhook-endpoint.dto';
import { EventStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import { generateId } from '../utils/id';
import { isRecordNotFound } from '../prisma/error-codes';

@Injectable()
export class WebhooksService {
  constructor(private readonly prisma: PrismaService) {}

  async create(accountId: string, dto: CreateWebhookEndpointDto) {
    const endpointId = generateId('whep');
    const secret = randomBytes(64).toString('base64');

    const endpoint = await this.prisma.webhookEndpoint.create({
      data: {
        id: endpointId,
        accountId,
        url: dto.url,
        // TODO: encrypt the secret later with AES-256-GCM
        secret,
        subscribedEvents: dto.subscribedEvents,
      },
      select: {
        id: true,
        url: true,
        active: true,
        subscribedEvents: true,
      },
    });

    return {
      ...endpoint,
      secretKey: `sk-${endpoint.id}:${secret}`,
    };
  }

  async findAll(accountId: string) {
    return this.prisma.webhookEndpoint.findMany({
      where: { accountId },
      omit: { secret: true, deletedAt: true },
    });
  }

  async findOne(id: string, accountId: string) {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { id, accountId },
      omit: { deletedAt: true },
    });

    if (!endpoint) {
      throw new NotFoundException('Webhook endpoint not found');
    }

    return endpoint;
  }

  async update(id: string, accountId: string, dto: UpdateWebhookEndpointDto) {
    return this.prisma.$transaction(async (tx) => {
      // 1️⃣ Ensure endpoint exists
      const endpoint = await tx.webhookEndpoint.findUnique({
        where: { id, accountId },
        select: {
          id: true,
          url: true,
        },
      });

      if (!endpoint) {
        throw new NotFoundException('Webhook endpoint not found');
      }

      // 2️⃣ If URL is changing, ensure no jobs are in flight
      const isUrlChanging = dto.url !== undefined && dto.url !== endpoint.url;

      if (isUrlChanging) {
        const hasActiveEvents = await tx.webhookEvent.findFirst({
          where: {
            endpointId: id,
            status: {
              in: [EventStatus.Pending, EventStatus.Processing],
            },
          },
          select: { id: true },
        });

        if (hasActiveEvents) {
          throw new BadRequestException(
            'Cannot update webhook URL while events are being processed',
          );
        }
      }

      // 3️⃣ Perform update
      const updated = await tx.webhookEndpoint.update({
        where: { id, accountId },
        data: dto,
        select: {
          id: true,
          url: true,
          active: true,
          subscribedEvents: true,
        },
      });

      return updated;
    });
  }

  async delete(id: string, accountId: string) {
    try {
      await this.prisma.webhookEndpoint.update({
        where: { id, accountId },
        data: { active: false, deletedAt: new Date() },
      });
    } catch (error) {
      if (isRecordNotFound(error))
        throw new NotFoundException('Webhook endpoint not found');
      throw error;
    }
  }
}
