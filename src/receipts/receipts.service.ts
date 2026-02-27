import { Injectable } from '@nestjs/common';
import { GenerateReceiptDto } from './dto/generate-receipt.dto';
import PDFDocument from 'pdfkit';
import { formatUSD } from '../utils/formatter';
import { InjectMinio } from '../minio/minio.decorator';
import * as Minio from 'minio';
import { PrismaService } from '../prisma/prisma.service';
import { EventStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { PassThrough, Readable } from 'stream';

@Injectable()
export class ReceiptsService {
  private readonly BUCKET_NAME = 'receipts';

  constructor(
    @InjectMinio() private minio: Minio.Client,
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {}

  private encryptReceipt(buffer: Buffer) {
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
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      iv: iv.toString('hex'),
      encrypted,
      authTag: authTag.toString('hex'),
      keyVersion,
    };
  }

  private decryptReceipt(
    encryptedFileStream: Readable,
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
    const passthrough = new PassThrough();
    encryptedFileStream.pipe(decipher).pipe(passthrough);
    return passthrough;
  }

  async getReceiptFile(receiptId: string) {
    const {
      bucket,
      mimetype,
      object: objectName,
      iv,
      keyVersion,
      authTag,
    } = await this.prisma.file.findFirstOrThrow({
      where: { receipt: { id: receiptId } },
      select: {
        bucket: true,
        object: true,
        mimetype: true,
        authTag: true,
        keyVersion: true,
        iv: true,
      },
    });
    const object = await this.minio.getObject(bucket, objectName);
    const decrypted = this.decryptReceipt(object, iv, authTag!, keyVersion);
    return { object: decrypted, mimetype, objectName };
  }

  async generateReceipt(dto: GenerateReceiptDto) {
    const { receiptNumber } = dto;

    /**
     * STEP 1 — Atomically claim generation
     */
    const claimed = await this.prisma.receipt.updateMany({
      where: {
        number: receiptNumber,
        status: { not: EventStatus.Done },
      },
      data: {
        status: EventStatus.Processing,
        generatedAt: new Date(),
      },
    });

    // If no row updated, it's already Done
    if (claimed.count === 0) {
      return;
    }

    const buffer = await this.generatePdfBuffer(dto);
    const { authTag, iv, keyVersion, encrypted } = this.encryptReceipt(buffer);

    const objectName = `receipt_${receiptNumber}.pdf`;

    if (!(await this.minio.bucketExists(this.BUCKET_NAME))) {
      await this.minio.makeBucket(this.BUCKET_NAME);
    }

    await this.minio.putObject(
      this.BUCKET_NAME,
      objectName,
      encrypted,
      buffer.length,
      { 'Content-Type': 'application/pdf' },
    );

    await this.prisma.file.upsert({
      where: {
        bucket_object: { bucket: this.BUCKET_NAME, object: objectName },
      },
      create: {
        bucket: this.BUCKET_NAME,
        object: objectName,
        size: buffer.length,
        authTag,
        keyVersion,
        encryptionAlgorithm: 'aes-256-gcm',
        iv,
        mimetype: 'application/pdf',
        receipt: {
          connect: { number: receiptNumber },
        },
      },
      update: {
        size: buffer.length,
        object: objectName,
      },
    });

    await this.prisma.receipt.update({
      where: { number: receiptNumber },
      data: {
        status: EventStatus.Done,
      },
    });
  }

  private generatePdfBuffer(dto: GenerateReceiptDto): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ font: 'Helvetica' });

      const chunks: Buffer[] = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const { amount, fromAccountId, toAccountId, receiptNumber, timestamp } =
        dto;

      const paddedReceiptNumber = `#${receiptNumber}`;
      const formattedAmount = formatUSD(amount, true);
      const formattedDate = timestamp.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      doc
        .fontSize(20)
        .font('Helvetica-Bold')
        .text('RECEIPT', { align: 'center' })
        .moveDown();

      doc
        .fontSize(10)
        .font('Helvetica')
        .text(`Receipt #: ${paddedReceiptNumber}`)
        .moveDown(0.5);

      doc.text(`Date: ${formattedDate}`).moveDown();

      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown();

      doc
        .fontSize(11)
        .font('Helvetica-Bold')
        .text('Transaction Details', { underline: true })
        .moveDown(0.5);

      doc.font('Helvetica').fontSize(10);
      doc.text(`From Account: ${fromAccountId}`);
      doc.text(`To Account: ${toAccountId}`);
      doc.text(`Amount: ${formattedAmount}`).moveDown();

      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown(0.5);
      doc
        .fontSize(9)
        .text('Thank you for your transaction', { align: 'center' });

      doc.end();
    });
  }
}
