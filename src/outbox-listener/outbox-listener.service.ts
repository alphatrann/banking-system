import {
  Injectable,
  OnModuleInit,
  BeforeApplicationShutdown,
  Inject,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { Client } from 'pg';
import { OutboxService } from 'src/outbox/outbox.service';

@Injectable()
export class OutboxListenerService
  implements OnModuleInit, BeforeApplicationShutdown
{
  private interval: NodeJS.Timeout | null = null;
  private listener: Client | null = null;
  private isProcessing = false;
  private isShuttingDown = false;
  private readonly MAX_MS_IN_FLIGHT_WAITING = 200;

  constructor(
    private configService: ConfigService,
    private outboxService: OutboxService,
    @Inject(WINSTON_MODULE_NEST_PROVIDER) private logger: Logger,
  ) {}

  async onModuleInit() {
    this.listener = new Client({
      connectionString: this.configService.getOrThrow('DATABASE_URL'),
    });

    await this.listener.connect();
    await this.listener.query('LISTEN outbox_channel');

    this.listener.on('notification', this.handleOutbox.bind(this));
    this.interval = setInterval(this.handleOutbox.bind(this), 5000);
  }

  private async handleOutbox() {
    if (this.isProcessing || this.isShuttingDown) return;
    try {
      this.isProcessing = true;
      await this.outboxService.pollOutbox();
    } catch (error) {
      this.logger.error('outbox.handle.error', {
        component: 'outbox',
        error: error instanceof Error ? error.stack : String(error),
      });
    } finally {
      this.isProcessing = false;
    }
  }

  async beforeApplicationShutdown() {
    this.logger.log('outbox.handle.shutting_down', { component: 'outbox' });
    this.isShuttingDown = true;
    if (this.interval) clearInterval(this.interval);
    this.listener?.removeAllListeners('notification');

    while (this.isProcessing) {
      this.logger.log('outbox.handle.waiting', {
        component: 'outbox',
        waitDurationMs: this.MAX_MS_IN_FLIGHT_WAITING,
      });
      await new Promise((resolve) =>
        setTimeout(resolve, this.MAX_MS_IN_FLIGHT_WAITING),
      );
    }

    try {
      await this.listener?.end();
    } catch (error) {
      this.logger.error('outbox.handle.error', {
        component: 'outbox',
        error: error instanceof Error ? error.stack : String(error),
      });
    }
  }
}
