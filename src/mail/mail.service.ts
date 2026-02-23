import { MailerService } from '@nestjs-modules/mailer';
import { Injectable } from '@nestjs/common';
import { ConfirmTransactionContext } from './contexts/confirm-transaction.context';
import { formatUSD } from '../utils/formatter';
import Mail from 'nodemailer/lib/mailer';

@Injectable()
export class MailService {
  constructor(private mailerService: MailerService) {}

  async sendConfirmTransferEmail(
    to: string,
    context: ConfirmTransactionContext,
    receipt: Mail.Attachment,
  ) {
    await this.mailerService.sendMail({
      from: 'Banking System <no-reply@banking-system.com>',
      to,
      date: context.timestamp,
      subject: `Confirmation - Transaction ${context.transactionId}`,
      template: './confirm-transaction',
      attachments: [receipt],
      context: {
        ...context,
        amount: formatUSD(context.amount, true),
        timestamp: context.timestamp.toLocaleString('en-US'),
        currentYear: new Date().getFullYear(),
      },
    });
  }
}
