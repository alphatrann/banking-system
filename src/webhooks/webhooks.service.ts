import {
  Injectable,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { UpdateWebhookEndpointDto } from './dto/update-webhook-endpoint.dto';
import { EventStatus, Prisma } from '@prisma/client';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { generateId } from '../utils/id';
import { isRecordNotFound, isUniqueViolation } from '../prisma/error-codes';
import { WebhookEventType } from './enums';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private encryptSecret(secret: string) {
    const keyVersion = +this.configService.getOrThrow(
      'WEBHOOK_ENC_ACTIVE_KEY_VERSION',
    );
    const masterKey = this.configService.getOrThrow(
      `WEBHOOK_ENC_MASTER_KEY_V${keyVersion}`,
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      Buffer.from(masterKey, 'base64'),
      iv,
    );
    const encrypted = Buffer.concat([
      cipher.update(secret, 'utf-8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
      iv: iv.toString('hex'),
      encryptedSecret: encrypted.toString('hex'),
      keyVersion,
      authTag: authTag.toString('hex'),
    };
  }

  private decryptSecret(
    encryptedSecret: string,
    iv: string,
    authTag: string,
    keyVersion: number,
  ) {
    const masterKey = this.configService.getOrThrow(
      `WEBHOOK_ENC_MASTER_KEY_V${keyVersion}`,
    );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(masterKey, 'base64'),
      Buffer.from(iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedSecret, 'hex')),
      decipher.final(),
    ]);

    return decrypted.toString('utf-8');
  }

  async create(accountId: string, dto: CreateWebhookEndpointDto) {
    const endpointId = generateId('whep');
    const secret = randomBytes(64).toString('hex');
    const { iv, encryptedSecret, keyVersion, authTag } =
      this.encryptSecret(secret);

    try {
      const endpoint = await this.prisma.webhookEndpoint.create({
        data: {
          id: endpointId,
          accountId,
          url: dto.url,
          encryptedSecret,
          keyVersion,
          iv,
          encryptionAlgorithm: 'aes-256-gcm',
          authTag,
          subscribedEvents: dto.subscribedEvents,
        },
        select: {
          id: true,
          url: true,
          active: true,
          subscribedEvents: true,
        },
      });

      return { ...endpoint, secret };
    } catch (error) {
      if (isUniqueViolation(error))
        throw new BadRequestException('Webhook URL already exists');

      throw new InternalServerErrorException(
        'Something went wrong when registering a webhook URL',
      );
    }
  }

  async findAll(accountId: string) {
    return this.prisma.webhookEndpoint.findMany({
      where: { accountId, deletedAt: null },
      select: {
        id: true,
        url: true,
        active: true,
        subscribedEvents: true,
        createdAt: true,
      },
    });
  }

  async findRegisteredEndpointIds(
    subscribedEvent: WebhookEventType,
    accountId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const webhookEndpointIds = await (
      tx ?? this.prisma
    ).webhookEndpoint.findMany({
      where: {
        active: true,
        subscribedEvents: { has: subscribedEvent },
        accountId,
        deletedAt: null,
      },
      select: { id: true },
    });
    return webhookEndpointIds.map(({ id }) => id);
  }

  async findOne(id: string) {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { id, deletedAt: null },
      select: {
        id: true,
        url: true,
        encryptedSecret: true,
        active: true,
        accountId: true,
        subscribedEvents: true,
        createdAt: true,
        keyVersion: true,
        authTag: true,
        iv: true,
      },
    });
    if (!endpoint) return;
    const secret = this.decryptSecret(
      endpoint.encryptedSecret,
      endpoint.iv,
      endpoint.authTag!,
      endpoint.keyVersion,
    );

    return {
      id: endpoint.id,
      url: endpoint.url,
      secret,
      accountId: endpoint.accountId,
      active: endpoint.active,
      subscribedEvents: endpoint.subscribedEvents,
      createdAt: endpoint.createdAt,
    };
  }

  async update(id: string, accountId: string, dto: UpdateWebhookEndpointDto) {
    return this.prisma.$transaction(async (tx) => {
      const endpoint = await tx.webhookEndpoint.findUnique({
        where: { id, accountId, deletedAt: null },
        select: {
          id: true,
          url: true,
          active: true,
          subscribedEvents: true,
          createdAt: true,
        },
      });

      if (!endpoint) {
        throw new NotFoundException('Webhook endpoint not found');
      }

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
        where: { id, accountId, deletedAt: null },
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
        where: { id, accountId, deletedAt: null },
        data: { active: false, deletedAt: new Date() },
      });
    } catch (error) {
      if (isRecordNotFound(error))
        throw new NotFoundException('Webhook endpoint not found');
      throw error;
    }
  }
}
