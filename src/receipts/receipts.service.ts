import { Injectable } from '@nestjs/common';
import { GenerateReceiptDto } from './dto/generate-receipt.dto';
import PDFDocument from 'pdfkit';
import { formatUSD } from '../utils/formatter';
import { InjectMinio } from '../minio/minio.decorator';
import * as Minio from 'minio';
import { PrismaService } from '../prisma/prisma.service';
import { randomBytes } from 'crypto';
import { EventStatus } from '@prisma/client';
import { simulateError } from '../utils/simulation';

@Injectable()
export class ReceiptsService {
  private readonly BUCKET_NAME = 'receipts';

  constructor(
    @InjectMinio() private minio: Minio.Client,
    private prisma: PrismaService,
  ) {}

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

    /**
     * STEP 2 — Generate PDF buffer (deterministic)
     */
    const buffer = await this.generatePdfBuffer(dto);

    const objectName = `receipt_${receiptNumber}.pdf`;

    /**
     * STEP 3 — Upload (overwrite safe)
     */
    if (!(await this.minio.bucketExists(this.BUCKET_NAME))) {
      await this.minio.makeBucket(this.BUCKET_NAME);
    }
    await this.minio.putObject(
      this.BUCKET_NAME,
      objectName,
      buffer,
      buffer.length,
      { 'Content-Type': 'application/pdf' },
    );

    simulateError(0.8, 'uploading PDF receipt to MinIO');

    /**
     * STEP 4 — Insert a file record
     */
    await this.prisma.file.upsert({
      where: {
        bucket_object: { bucket: this.BUCKET_NAME, object: objectName },
      },
      create: {
        bucket: this.BUCKET_NAME,
        object: objectName,
        size: buffer.length,
        mimetype: 'application/pdf',
        iv: randomBytes(16).toString('base64'),
        receipt: {
          connect: { number: receiptNumber },
        },
      },
      update: {
        size: buffer.length,
        object: objectName,
      },
    });
    simulateError(0.8, 'adding file to db');

    /**
     * STEP 5 — Mark receipt Done
     */
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
