import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { generateId } from '../src/utils/id';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Positive balance after concurrent transactions test', () => {
  let app: INestApplication<App>;
  let accessToken: string;
  let toAccountId: string;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    console.log('NODE_ENV:', process.env.NODE_ENV);
    await app.init();

    const accountPayload = {
      email: `user_${Date.now()}_${Math.random()}@test.com`,
      password: 'Test123@',
    };
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(accountPayload);
    const firstAccountLoginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send(accountPayload);
    const destinationAccountRegisterResponse = await request(
      app.getHttpServer(),
    )
      .post('/auth/register')
      .send({
        ...accountPayload,
        email: `user_${Date.now()}_${Math.random()}@test.com`,
      });
    accessToken = firstAccountLoginResponse.body.accessToken;
    console.log({ regData: destinationAccountRegisterResponse.body });
    toAccountId = destinationAccountRegisterResponse.body.data.id;
  });

  afterEach(async () => {
    const prisma = app.get(PrismaService);
    await prisma.$disconnect();
    await app.close();
  });

  it('two transactions with the same idempotency key should not double charge', async () => {
    const idempotencyKey = 'single-key';
    async function transfer() {
      return await request(app.getHttpServer())
        .post('/transfer')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Idempotency-Key', idempotencyKey)
        .send({ amount: 10, toAccountId });
    }
    const firstTransferResponse = await transfer();
    const secondTransferResponse = await transfer();

    expect(firstTransferResponse.body).toEqual(secondTransferResponse.body);
  });

  it('the final balance should never be negative after multiple transactions', async () => {
    const concurrentTransactions = Array.from({ length: 20 }, async () => {
      await request(app.getHttpServer())
        .post('/transfer')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Idempotency-Key', generateId('ik'))
        .send({ amount: 30, toAccountId });
    });

    await Promise.allSettled(concurrentTransactions);

    const balanceResponse = await request(app.getHttpServer())
      .get('/balance')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // the result may not be 10 due to serialization behavior, but most importantly, the balance is never negative
    expect(balanceResponse.body.balance).toBeGreaterThanOrEqual(0);
  });
});
